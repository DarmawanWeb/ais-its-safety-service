// Drizzle definitions of the "safety" schema (docs/PLATFORM_SPEC.md §6).
// The SQL files in migrations/ create the tables; these definitions MUST
// mirror them and only type the queries.
import type {
  AlertDomain,
  AlertSeverity,
  AlertType,
  CollisionRisk,
  SafetyEventStatus,
  VesselStatus,
  ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';
import { geography } from '@darmawanweb/ais-its-nest/db';
import * as pg from 'drizzle-orm/pg-core';

/** The service's PostgreSQL schema, owned by the role `safety_svc`. */
export const serviceSchema = pg.pgSchema('safety');

const timestamptz = (name: string) =>
  pg.timestamp(name, { withTimezone: true });

/** Projection of the `GEO` stream (`safety-zones`), tombstoned on deletion. */
export const zones = serviceSchema.table(
  'zones',
  {
    id: pg.uuid('id').primaryKey(),
    orgId: pg.uuid('org_id'),
    code: pg.text('code').notNull(),
    name: pg.text('name').notNull(),
    kind: pg.text('kind').$type<ZoneKind>().notNull(),
    geom: geography('geom', { subtype: 'Geometry' }).notNull(),
    bufferM: pg.doublePrecision('buffer_m').notNull().default(0),
    active: pg.boolean('active').notNull(),
    alertOnEnter: pg.boolean('alert_on_enter').notNull(),
    properties: pg
      .jsonb('properties')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    sourceUpdatedAt: timestamptz('source_updated_at').notNull(),
    deletedAt: timestamptz('deleted_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [pg.index('zones_kind_idx').on(table.kind)],
);

/** Projection of the `FLEET` stream (`safety-fleet`): mmsi → organization. */
export const vessels = serviceSchema.table(
  'vessels',
  {
    id: pg.uuid('id').primaryKey(),
    mmsi: pg.integer('mmsi').notNull(),
    orgId: pg.uuid('org_id'),
    name: pg.text('name').notNull(),
    imo: pg.text('imo'),
    flag: pg.text('flag'),
    typeCode: pg.text('type_code'),
    status: pg.text('status').$type<VesselStatus>().notNull(),
    sourceUpdatedAt: timestamptz('source_updated_at').notNull(),
    deletedAt: timestamptz('deleted_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    pg.uniqueIndex('vessels_mmsi_key').on(table.mmsi),
    pg.index('vessels_org_idx').on(table.orgId, table.mmsi),
  ],
);

/** `closest_encounter` of `vessel_state` (contracts `ClosestEncounter`). */
export interface ClosestEncounterJson {
  readonly otherMmsi: number;
  readonly cpaNm: number;
  readonly tcpaMin: number;
}

/** Latest safety state per vessel (`0001_init.sql`). */
export const vesselState = serviceSchema.table(
  'vessel_state',
  {
    mmsi: pg.integer('mmsi').primaryKey(),
    time: timestamptz('time').notNull(),
    geom: geography('geom', { subtype: 'Point' }).notNull(),
    sog: pg.doublePrecision('sog').notNull(),
    cog: pg.doublePrecision('cog').notNull(),
    hdg: pg.doublePrecision('hdg').notNull(),
    navstatus: pg.smallint('navstatus').notNull(),
    predNavstatus: pg.smallint('pred_navstatus').notNull(),
    ewsStatus: pg.smallint('ews_status').notNull().default(3),
    pipelineDistM: pg.doublePrecision('pipeline_dist_m'),
    nearestPipelineZoneId: pg.uuid('nearest_pipeline_zone_id'),
    ewsEvaluatedAt: timestamptz('ews_evaluated_at'),
    collisionRisk: pg
      .text('collision_risk')
      .$type<CollisionRisk>()
      .notNull()
      .default('none'),
    closestEncounter: pg
      .jsonb('closest_encounter')
      .$type<ClosestEncounterJson>(),
    collisionEvaluatedAt: timestamptz('collision_evaluated_at'),
    evaluatedAt: timestamptz('evaluated_at').notNull(),
    publishedState: pg
      .jsonb('published_state')
      .$type<Record<string, unknown>>(),
    publishedAt: timestamptz('published_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [pg.index('vessel_state_time_idx').on(table.time)],
);

/**
 * Detector events (`0001_init.sql`): one row per published alert, written by
 * the AlertPersistence hook before the alert is published. A hypertable on
 * `time`, hence the composite primary key.
 */
export const events = serviceSchema.table(
  'events',
  {
    id: pg.uuid('id').notNull(),
    time: timestamptz('time').notNull(),
    /** Detector that raised the alert (`DETECTORS` id). */
    detector: pg.text('detector').notNull(),
    type: pg.text('type').$type<AlertType>().notNull(),
    domain: pg.text('domain').$type<AlertDomain>().notNull(),
    /** Severity of this published alert. */
    severity: pg.text('severity').$type<AlertSeverity>().notNull(),
    /** Current severity of the occurrence (lower after a de-escalation). */
    currentSeverity: pg
      .text('current_severity')
      .$type<AlertSeverity>()
      .notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    relatedMmsi: pg.integer('related_mmsi'),
    zoneId: pg.uuid('zone_id'),
    geom: geography('geom', { subtype: 'Point' }),
    title: pg.text('title').notNull(),
    message: pg.text('message').notNull(),
    methodId: pg.text('method_id').notNull(),
    dedupKey: pg.text('dedup_key').notNull(),
    data: pg.jsonb('data').$type<Record<string, unknown>>().notNull(),
    status: pg.text('status').$type<SafetyEventStatus>().notNull(),
    openedAt: timestamptz('opened_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at').notNull(),
    resolvedAt: timestamptz('resolved_at'),
    resolution: pg.jsonb('resolution').$type<Record<string, unknown>>(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    pg.primaryKey({ columns: [table.id, table.time] }),
    pg.index('events_open_idx').on(table.dedupKey),
    pg.index('events_time_idx').on(table.time, table.id),
    pg.index('events_mmsi_time_idx').on(table.mmsi, table.time),
  ],
);

/** One vessel of an encounter sample (`encounters.positions`). */
export interface EncounterVesselPosition {
  readonly mmsi: number;
  /** ISO-8601 time of the vessel's report. */
  readonly time: string;
  readonly lat: number;
  readonly lon: number;
  readonly sog: number;
  readonly cog: number;
}

/** `encounters.positions`: the two reports the sample was computed from. */
export interface EncounterPositionsJson {
  readonly a: EncounterVesselPosition;
  readonly b: EncounterVesselPosition;
}

/** CPA/TCPA samples of vessel pairs at risk (hypertable, `0001_init.sql`). */
export const encounters = serviceSchema.table(
  'encounters',
  {
    time: timestamptz('time').notNull(),
    mmsiA: pg.integer('mmsi_a').notNull(),
    mmsiB: pg.integer('mmsi_b').notNull(),
    encounterId: pg.uuid('encounter_id').notNull(),
    cpaNm: pg.doublePrecision('cpa_nm').notNull(),
    tcpaMin: pg.doublePrecision('tcpa_min'),
    rangeNm: pg.doublePrecision('range_nm').notNull(),
    risk: pg.text('risk').$type<CollisionRisk>().notNull(),
    positions: pg.jsonb('positions').$type<EncounterPositionsJson>().notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    pg.primaryKey({ columns: [table.mmsiA, table.mmsiB, table.time] }),
    pg.index('encounters_time_idx').on(table.time),
    pg.index('encounters_mmsi_b_time_idx').on(table.mmsiB, table.time),
    pg.index('encounters_encounter_idx').on(table.encounterId, table.time),
  ],
);
