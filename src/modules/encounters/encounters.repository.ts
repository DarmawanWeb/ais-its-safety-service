import {
  type BBox,
  COLLISION_RISKS,
  type CollisionRisk,
} from '@darmawanweb/ais-its-contracts/domain';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  max,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';

import { scopeCondition } from '../../common/tenancy.sql.js';
import type { SafetyReadScope } from '../../common/tenancy.js';
import { vesselIdentities } from '../../common/vessel-identity.js';
import * as schema from '../../db/schema.js';
import type {
  EncounterFilter,
  EncounterHistorySample,
  EncounterRecord,
  EncounterSample,
} from './encounter.js';

const { encounters, vesselState } = schema;

/** Rank of a band (`none` 0 … `high` 3), the order of contracts `COLLISION_RISKS`. */
const riskRank = (risk: CollisionRisk): number => COLLISION_RISKS.indexOf(risk);

/** SQL rank of the `risk` column, same order as {@link riskRank}. */
const RISK_RANK_SQL = sql`CASE ${encounters.risk} ${sql.join(
  COLLISION_RISKS.map(
    (risk) => sql`WHEN ${risk} THEN ${sql.raw(String(riskRank(risk)))}`,
  ),
  sql` `,
)} END`;

const PEAK_RANK = sql<number>`max(${RISK_RANK_SQL})`;
const LAST_SAMPLE_AT = sql`max(${encounters.time})`;

/** `true` when the report `side` (`a` or `b`) of a sample lies in the box (lon/lat space, like `?bbox` elsewhere). */
function reportInBBox(
  side: 'a' | 'b',
  [minLon, minLat, maxLon, maxLat]: BBox,
): SQL {
  const report = sql`${encounters.positions} -> ${sql.raw(`'${side}'`)}`;
  return sql`((${report} ->> 'lon')::float8 BETWEEN ${minLon} AND ${maxLon} AND (${report} ->> 'lat')::float8 BETWEEN ${minLat} AND ${maxLat})`;
}

/** The band of a rank computed by {@link RISK_RANK_SQL}. */
function riskOfRank(rank: number): CollisionRisk {
  return COLLISION_RISKS[rank] ?? 'none';
}

/** `encounters` hypertable: samples written by the collision detector, read by the REST API. */
@Injectable()
export class EncountersRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /**
   * The collision detector's event clock as stored: the newest
   * `vessel_state.collision_evaluated_at`, i.e. the AIS time of the newest
   * position the detector evaluated (every evaluation reports the vessel's
   * collision state, written every `SAFETY_STATE_FLUSH_MS`). Shared by every
   * instance and deployment of the schema; `undefined` before the first
   * evaluation. Index `vessel_state_collision_evaluated_idx` (`0003`).
   */
  async collisionClock(): Promise<Date | undefined> {
    const [row] = await this.db
      .select({ at: max(vesselState.collisionEvaluatedAt) })
      .from(vesselState);
    return row?.at ?? undefined;
  }

  /** Inserts samples; a repeated sample (same pair and time) is ignored. */
  async insert(samples: readonly EncounterSample[]): Promise<void> {
    if (samples.length === 0) return;
    await this.db
      .insert(encounters)
      .values(
        samples.map((sample) => ({
          time: sample.time,
          mmsiA: sample.mmsiA,
          mmsiB: sample.mmsiB,
          encounterId: sample.encounterId,
          cpaNm: sample.cpaNm,
          tcpaMin: sample.tcpaMin,
          rangeNm: sample.rangeNm,
          risk: sample.risk,
          positions: sample.positions,
        })),
      )
      .onConflictDoNothing();
  }

  /**
   * Encounters with samples in the filter's range that `scope` may read,
   * newest encounter first (`encounter_id` DESC: UUIDv7 of the start, an
   * immutable key), `limit` encounters, each with its samples in the range.
   * Two statements: the encounters (grouped samples), then their history.
   */
  async list(
    filter: EncounterFilter,
    scope: SafetyReadScope,
  ): Promise<EncounterRecord[]> {
    const inRange = and(
      gte(encounters.time, filter.from),
      lt(encounters.time, filter.to),
    );
    const conditions: (SQL | undefined)[] = [
      inRange,
      scopeCondition(scope, [encounters.mmsiA, encounters.mmsiB]),
    ];
    if (filter.mmsi !== undefined)
      conditions.push(
        or(
          eq(encounters.mmsiA, filter.mmsi),
          eq(encounters.mmsiB, filter.mmsi),
        ),
      );
    if (filter.encounterId !== undefined)
      conditions.push(eq(encounters.encounterId, filter.encounterId));
    // Conditions on the encounter as a whole (subqueries on its id), so the
    // aggregates below still cover all of its samples in the range.
    if (filter.bbox !== undefined) {
      const { bbox } = filter;
      conditions.push(
        inArray(
          encounters.encounterId,
          this.db
            .selectDistinct({ encounterId: encounters.encounterId })
            .from(encounters)
            .where(
              and(
                inRange,
                or(reportInBBox('a', bbox), reportInBBox('b', bbox)),
              ),
            ),
        ),
      );
    }
    if (filter.activity !== undefined) {
      // Activity is decided per pair: the latest sample of each pair since
      // the cut-off (DISTINCT ON the pair, newest first) names the one
      // encounter of the pair that can be active. An encounter followed by a
      // newer one of the same pair — a takeover or restart starts the pair
      // over with a new encounter id, without a closing `none` sample —
      // therefore counts as ended.
      const latest = this.db
        .selectDistinctOn([encounters.mmsiA, encounters.mmsiB], {
          encounterId: encounters.encounterId,
          risk: encounters.risk,
        })
        .from(encounters)
        .where(gte(encounters.time, filter.activity.since))
        .orderBy(encounters.mmsiA, encounters.mmsiB, desc(encounters.time))
        .as('latest');
      const active = this.db
        .select({ encounterId: latest.encounterId })
        .from(latest)
        .where(ne(latest.risk, 'none'));
      conditions.push(
        filter.activity.active
          ? inArray(encounters.encounterId, active)
          : notInArray(encounters.encounterId, active),
      );
    }
    if (filter.after !== undefined)
      conditions.push(lt(encounters.encounterId, filter.after.encounterId));
    const having: SQL[] = [];
    if (filter.peakRisks !== undefined)
      having.push(inArray(PEAK_RANK, filter.peakRisks.map(riskRank)));

    const groups = await this.db
      .select({
        encounterId: encounters.encounterId,
        mmsiA: encounters.mmsiA,
        mmsiB: encounters.mmsiB,
        startedAt: sql`min(${encounters.time})`.mapWith(encounters.time),
        lastSampleAt: LAST_SAMPLE_AT.mapWith(encounters.time),
        peakRank: PEAK_RANK.mapWith(Number),
        minCpaNm: sql`min(${encounters.cpaNm})`.mapWith(Number),
      })
      .from(encounters)
      .where(and(...conditions))
      .groupBy(encounters.encounterId, encounters.mmsiA, encounters.mmsiB)
      .having(having.length === 0 ? undefined : and(...having))
      .orderBy(desc(encounters.encounterId))
      .limit(filter.limit);
    if (groups.length === 0) return [];

    const samples = await this.db
      .select()
      .from(encounters)
      .where(
        and(
          inRange,
          inArray(
            encounters.encounterId,
            groups.map((group) => group.encounterId),
          ),
        ),
      )
      .orderBy(asc(encounters.time));
    const history = new Map<string, EncounterHistorySample[]>();
    for (const sample of samples) {
      const list = history.get(sample.encounterId) ?? [];
      list.push({
        time: sample.time,
        cpaNm: sample.cpaNm,
        tcpaMin: sample.tcpaMin,
        rangeNm: sample.rangeNm,
        risk: sample.risk,
        positions: sample.positions,
      });
      history.set(sample.encounterId, list);
    }
    const identities = await vesselIdentities(
      this.db,
      groups.flatMap((group) => [group.mmsiA, group.mmsiB]),
    );
    return groups.map((group) => ({
      encounterId: group.encounterId,
      mmsiA: group.mmsiA,
      mmsiB: group.mmsiB,
      vesselA: identities.get(group.mmsiA) ?? null,
      vesselB: identities.get(group.mmsiB) ?? null,
      startedAt: group.startedAt,
      lastSampleAt: group.lastSampleAt,
      peakRisk: riskOfRank(group.peakRank),
      minCpaNm: group.minCpaNm,
      history: history.get(group.encounterId) ?? [],
    }));
  }
}
