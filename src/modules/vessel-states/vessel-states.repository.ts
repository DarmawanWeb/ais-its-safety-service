import {
  type CollisionRisk,
  CollisionRiskSchema,
  type EwsStatus,
  EwsStatusSchema,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  ClosestEncounterSchema,
  type SafetyVesselStateV1,
  SafetyVesselStateV1Schema,
} from '@darmawanweb/ais-its-contracts/events';
import {
  type Database,
  geographyIntersectsBBox,
  InjectDb,
  InjectPool,
  type Pool,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import * as z from 'zod';

import * as schema from '../../db/schema.js';
import {
  type SafetyStateReport,
  safetyStateMethodIds,
} from '../../domain/safety-state.js';
import type { VesselStateFilter, VesselStateRecord } from './vessel-state.js';

const { vesselState, vessels } = schema;

/** A merged state as stored, with its last publication (result of {@link VesselStatesRepository.upsertReports}). */
export interface StoredSafetyState {
  /** The state as `safety.vessel_state.updated.v1` carries it. */
  readonly state: SafetyVesselStateV1;
  /** The last published state, `null` when none was (or it no longer parses). */
  readonly published: SafetyVesselStateV1 | null;
}

/** Row shape of the upsert's `RETURNING` (validated: raw SQL is not typed by drizzle). */
const ReturnedRowSchema = z.object({
  mmsi: z.number().int(),
  evaluated_at: z.date(),
  ews_status: EwsStatusSchema,
  pipeline_dist_m: z.number().nullable(),
  nearest_pipeline_zone_id: z.string().nullable(),
  ews_evaluated_at: z.date().nullable(),
  collision_risk: CollisionRiskSchema,
  closest_encounter: ClosestEncounterSchema.nullable(),
  collision_evaluated_at: z.date().nullable(),
  published_state: z.unknown(),
});

/** "This report carries the part and it is not older than the stored one." */
const newerPart = (part: 'ews' | 'collision'): string =>
  `(EXCLUDED.${part}_evaluated_at IS NOT NULL AND (s.${part}_evaluated_at IS NULL OR EXCLUDED.${part}_evaluated_at >= s.${part}_evaluated_at))`;

const newerPosition = 'EXCLUDED.time > s.time';

const pick = (column: string, condition: string): string =>
  `${column} = CASE WHEN ${condition} THEN EXCLUDED.${column} ELSE s.${column} END`;

/**
 * Batched upsert of detector reports. Each report carries the latest
 * kinematics and optionally the EWS and/or collision part; every part only
 * replaces the stored one when it is not older, so reports of separately
 * deployed detectors merge in the row. Parameters are bound arrays
 * (`unnest`), one statement per batch.
 */
const UPSERT_REPORTS_SQL = `
INSERT INTO vessel_state AS s (
  mmsi, time, geom, sog, cog, hdg, navstatus, pred_navstatus,
  ews_status, pipeline_dist_m, nearest_pipeline_zone_id, ews_evaluated_at,
  collision_risk, closest_encounter, collision_evaluated_at, evaluated_at)
SELECT r.mmsi, r.time, ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326)::geography,
  r.sog, r.cog, r.hdg, r.navstatus, r.pred_navstatus,
  COALESCE(r.ews_status, 3), r.pipeline_dist_m, r.zone_id, r.ews_at,
  COALESCE(r.collision_risk, 'none'),
  CASE WHEN r.other_mmsi IS NULL THEN NULL
       ELSE jsonb_build_object('otherMmsi', r.other_mmsi, 'cpaNm', r.cpa_nm, 'tcpaMin', r.tcpa_min) END,
  r.collision_at,
  GREATEST(r.time, r.ews_at, r.collision_at)
FROM unnest($1::integer[], $2::timestamptz[], $3::float8[], $4::float8[], $5::float8[],
            $6::float8[], $7::float8[], $8::smallint[], $9::smallint[], $10::smallint[],
            $11::float8[], $12::uuid[], $13::timestamptz[], $14::text[], $15::integer[],
            $16::float8[], $17::float8[], $18::timestamptz[])
  AS r(mmsi, time, lon, lat, sog, cog, hdg, navstatus, pred_navstatus, ews_status,
       pipeline_dist_m, zone_id, ews_at, collision_risk, other_mmsi,
       cpa_nm, tcpa_min, collision_at)
ON CONFLICT (mmsi) DO UPDATE SET
  time = GREATEST(s.time, EXCLUDED.time),
  ${['geom', 'sog', 'cog', 'hdg', 'navstatus', 'pred_navstatus'].map((column) => pick(column, newerPosition)).join(',\n  ')},
  ${['ews_status', 'pipeline_dist_m', 'nearest_pipeline_zone_id'].map((column) => pick(column, newerPart('ews'))).join(',\n  ')},
  ews_evaluated_at = GREATEST(s.ews_evaluated_at, EXCLUDED.ews_evaluated_at),
  ${['collision_risk', 'closest_encounter'].map((column) => pick(column, newerPart('collision'))).join(',\n  ')},
  collision_evaluated_at = GREATEST(s.collision_evaluated_at, EXCLUDED.collision_evaluated_at),
  evaluated_at = GREATEST(s.evaluated_at, EXCLUDED.evaluated_at),
  updated_at = now()
RETURNING s.mmsi, s.evaluated_at, s.ews_status, s.pipeline_dist_m, s.nearest_pipeline_zone_id,
  s.ews_evaluated_at, s.collision_risk, s.closest_encounter, s.collision_evaluated_at,
  s.published_state`;

/** Records the last published state of each vessel (never moves it back in time). */
const MARK_PUBLISHED_SQL = `
UPDATE vessel_state AS s
SET published_state = v.state, published_at = v.at
FROM unnest($1::integer[], $2::jsonb[], $3::timestamptz[]) AS v(mmsi, state, at)
WHERE s.mmsi = v.mmsi AND (s.published_at IS NULL OR s.published_at <= v.at)`;

/** `vessel_state`: batched writes of the detectors' reports and the REST reads. */
@Injectable()
export class VesselStatesRepository {
  constructor(
    @InjectPool() private readonly pool: Pool,
    @InjectDb() private readonly db: Database<typeof schema>,
  ) {}

  /**
   * Upserts one report per vessel (callers merge reports of one vessel
   * first) and returns the merged states with their last publication.
   */
  async upsertReports(
    reports: readonly SafetyStateReport[],
  ): Promise<StoredSafetyState[]> {
    if (reports.length === 0) return [];
    const column = <T>(read: (report: SafetyStateReport) => T): T[] =>
      reports.map(read);
    const result = await this.pool.query(UPSERT_REPORTS_SQL, [
      column((r) => r.mmsi),
      column((r) => r.kinematics.time),
      column((r) => r.kinematics.lon),
      column((r) => r.kinematics.lat),
      column((r) => r.kinematics.sog),
      column((r) => r.kinematics.cog),
      column((r) => r.kinematics.hdg),
      column((r) => r.kinematics.navstatus),
      column((r) => r.kinematics.predictedNavstatus),
      column((r) => r.ews?.ewsStatus ?? null),
      column((r) => r.ews?.pipelineDistanceM ?? null),
      column((r) => r.ews?.nearestPipelineZoneId ?? null),
      column((r) => r.ews?.evaluatedAt ?? null),
      column((r) => r.collision?.collisionRisk ?? null),
      column((r) => r.collision?.closestEncounter?.otherMmsi ?? null),
      column((r) => r.collision?.closestEncounter?.cpaNm ?? null),
      column((r) => r.collision?.closestEncounter?.tcpaMin ?? null),
      column((r) => r.collision?.evaluatedAt ?? null),
    ]);
    return result.rows.map((raw) => {
      const row = ReturnedRowSchema.parse(raw);
      const published = SafetyVesselStateV1Schema.safeParse(
        row.published_state,
      );
      return {
        state: {
          mmsi: row.mmsi,
          time: row.evaluated_at.toISOString(),
          ewsStatus: row.ews_status,
          pipelineDistanceM: row.pipeline_dist_m,
          nearestPipelineZoneId: row.nearest_pipeline_zone_id,
          collisionRisk: row.collision_risk,
          closestEncounter: row.closest_encounter,
          methodIds: safetyStateMethodIds({
            ews: row.ews_evaluated_at !== null,
            collision: row.collision_evaluated_at !== null,
          }),
        },
        published: published.success ? published.data : null,
      };
    });
  }

  /** Stores the states just published (heartbeat and change detection). */
  async markPublished(states: readonly SafetyVesselStateV1[]): Promise<void> {
    if (states.length === 0) return;
    await this.pool.query(MARK_PUBLISHED_SQL, [
      states.map((state) => state.mmsi),
      states.map((state) => JSON.stringify(state)),
      states.map((state) => state.time),
    ]);
  }

  /** Latest states matching `filter`, ordered by MMSI. */
  async list(filter: VesselStateFilter): Promise<VesselStateRecord[]> {
    const conditions: SQL[] = [gte(vesselState.time, filter.since)];
    if (filter.bbox !== undefined)
      conditions.push(geographyIntersectsBBox(vesselState.geom, filter.bbox));
    if (filter.ewsStatuses !== undefined)
      conditions.push(inArray(vesselState.ewsStatus, [...filter.ewsStatuses]));
    if (filter.collisionRisks !== undefined)
      conditions.push(
        inArray(vesselState.collisionRisk, [...filter.collisionRisks]),
      );
    const rows = await this.selectStates()
      .where(and(...conditions))
      .orderBy(asc(vesselState.mmsi))
      .limit(filter.limit);
    return rows.map(toRecord);
  }

  /** The state of one vessel. */
  async get(mmsi: number): Promise<VesselStateRecord | undefined> {
    const [row] = await this.selectStates()
      .where(eq(vesselState.mmsi, mmsi))
      .limit(1);
    return row === undefined ? undefined : toRecord(row);
  }

  private selectStates() {
    return this.db
      .select({
        mmsi: vesselState.mmsi,
        evaluatedAt: vesselState.evaluatedAt,
        positionTime: vesselState.time,
        lat: sql<number>`ST_Y(${vesselState.geom}::geometry)`,
        lon: sql<number>`ST_X(${vesselState.geom}::geometry)`,
        sog: vesselState.sog,
        cog: vesselState.cog,
        hdg: vesselState.hdg,
        navstatus: vesselState.navstatus,
        predNavstatus: vesselState.predNavstatus,
        ewsStatus: vesselState.ewsStatus,
        pipelineDistM: vesselState.pipelineDistM,
        nearestPipelineZoneId: vesselState.nearestPipelineZoneId,
        ewsEvaluatedAt: vesselState.ewsEvaluatedAt,
        collisionRisk: vesselState.collisionRisk,
        closestEncounter: vesselState.closestEncounter,
        collisionEvaluatedAt: vesselState.collisionEvaluatedAt,
        updatedAt: vesselState.updatedAt,
        vesselId: vessels.id,
        vesselName: vessels.name,
      })
      .from(vesselState)
      .leftJoin(
        vessels,
        and(eq(vessels.mmsi, vesselState.mmsi), isNull(vessels.deletedAt)),
      )
      .$dynamic();
  }
}

type SelectedState = Awaited<
  ReturnType<ReturnType<VesselStatesRepository['selectStates']>['execute']>
>[number];

function toRecord(row: SelectedState): VesselStateRecord {
  return {
    mmsi: row.mmsi,
    evaluatedAt: row.evaluatedAt,
    position: {
      time: row.positionTime,
      lat: row.lat,
      lon: row.lon,
      sog: row.sog,
      cog: row.cog,
      hdg: row.hdg,
      navstatus: row.navstatus,
      predictedNavstatus: row.predNavstatus === 1 ? 1 : 0,
    },
    // The CHECK constraints guarantee the codes; parse instead of asserting.
    ewsStatus: EwsStatusSchema.parse(row.ewsStatus) satisfies EwsStatus,
    pipelineDistanceM: row.pipelineDistM,
    nearestPipelineZoneId: row.nearestPipelineZoneId,
    collisionRisk: row.collisionRisk satisfies CollisionRisk,
    closestEncounter: row.closestEncounter,
    methodIds: safetyStateMethodIds({
      ews: row.ewsEvaluatedAt !== null,
      collision: row.collisionEvaluatedAt !== null,
    }),
    vessel:
      row.vesselId === null || row.vesselName === null
        ? null
        : { id: row.vesselId, name: row.vesselName },
    updatedAt: row.updatedAt,
  };
}
