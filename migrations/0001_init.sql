-- 0001_init — initial schema of ais-its-safety-service (docs/PLATFORM_SPEC.md §6, §13.7).
--
-- Runs inside schema "safety" (search_path=safety,public) as the role
-- safety_svc, in one transaction. The infrastructure creates the extensions
-- (timescaledb, postgis, pgcrypto) in "public"; services never CREATE EXTENSION.
-- Migrations are forward-only: once applied anywhere, never edit this file
-- (its checksum is verified at startup) — add 0002_<change>.sql instead.

COMMENT ON SCHEMA safety IS 'safety service — owned by safety_svc';

-- ---------------------------------------------------------------------------
-- Projections of other services' data (spec §6: cross-service data arrives by
-- events). Snapshots apply only when newer; deletions leave a tombstone so an
-- older snapshot never resurrects a deleted entity. Both are rebuilt from the
-- compacted streams at startup (src/consumers/projection-rebuild.service.ts).
-- ---------------------------------------------------------------------------

-- GEO stream (durable consumer safety-zones).
CREATE TABLE zones (
  id                uuid PRIMARY KEY,
  org_id            uuid,
  code              text NOT NULL,
  name              text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('pipeline', 'transhipment_area', 'fishing_ground',
                      'mpa', 'restricted', 'anchorage', 'port', 'tss_lane', 'shallow_water', 'custom')),
  geom              geography(Geometry, 4326) NOT NULL,
  buffer_m          double precision NOT NULL DEFAULT 0,
  active            boolean NOT NULL,
  alert_on_enter    boolean NOT NULL,
  properties        jsonb NOT NULL DEFAULT '{}',
  -- ZoneSnapshotV1.updatedAt of the applied snapshot.
  source_updated_at timestamptz NOT NULL,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- When this row was last projected (rebuild bookkeeping).
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX zones_kind_idx ON zones (kind) WHERE deleted_at IS NULL;

-- FLEET stream (durable consumer safety-fleet): mmsi → vessel, organization (tenancy, spec §8.5).
CREATE TABLE vessels (
  id                uuid PRIMARY KEY,
  mmsi              integer NOT NULL,
  org_id            uuid,
  name              text NOT NULL,
  imo               text,
  flag              text,
  type_code         text,
  status            text NOT NULL CHECK (status IN ('active', 'inactive', 'laid_up')),
  -- VesselSnapshotV1.updatedAt of the applied snapshot.
  source_updated_at timestamptz NOT NULL,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX vessels_mmsi_key ON vessels (mmsi) WHERE deleted_at IS NULL;
CREATE INDEX vessels_org_idx ON vessels (org_id, mmsi) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Latest safety state per vessel (spec §13.7). The detectors report their part
-- (EWS columns, collision columns) and the latest kinematics; a writer merges
-- the reports (newest part wins) and publishes safety.vessel_state.updated.v1.
-- ---------------------------------------------------------------------------
CREATE TABLE vessel_state (
  mmsi                     integer PRIMARY KEY,
  -- Latest position (time, geom and the AIS fields of that report).
  time                     timestamptz NOT NULL,
  geom                     geography(Point, 4326) NOT NULL,
  sog                      double precision NOT NULL,
  cog                      double precision NOT NULL,
  hdg                      double precision NOT NULL,
  navstatus                smallint NOT NULL,
  pred_navstatus           smallint NOT NULL CHECK (pred_navstatus IN (0, 1)),
  -- EWS part (detector ews).
  ews_status               smallint NOT NULL DEFAULT 3 CHECK (ews_status IN (0, 1, 3)),
  pipeline_dist_m          double precision CHECK (pipeline_dist_m >= 0),
  nearest_pipeline_zone_id uuid,
  ews_evaluated_at         timestamptz,
  -- Collision part (detector collision).
  collision_risk           text NOT NULL DEFAULT 'none' CHECK (collision_risk IN ('none', 'low', 'medium', 'high')),
  closest_encounter        jsonb,
  collision_evaluated_at   timestamptz,
  -- Event time of the latest evaluation (SafetyVesselStateV1.time).
  evaluated_at             timestamptz NOT NULL,
  -- Last state published to the SAFETY stream (heartbeat and change detection).
  published_state          jsonb,
  published_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Bounding-box queries compare in lon/lat geometry space (kit geographyIntersectsBBox).
CREATE INDEX vessel_state_geom_idx ON vessel_state USING gist ((geom::geometry));
CREATE INDEX vessel_state_time_idx ON vessel_state (time DESC);
CREATE INDEX vessel_state_at_risk_idx ON vessel_state (ews_status, collision_risk)
  WHERE ews_status <> 3 OR collision_risk <> 'none';

-- ---------------------------------------------------------------------------
-- Detector events: one row per published alert (AlertPersistence, spec §18).
-- An escalation publishes a new alert id for the same dedup_key and resolves
-- the previous row; restarts restore the open rows (loadOpen). Rows change
-- while open (resolution, de-escalation), so the table is not compressed.
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id               uuid NOT NULL,
  time             timestamptz NOT NULL,
  detector         text NOT NULL,
  type             text NOT NULL,
  domain           text NOT NULL CHECK (domain IN ('safety', 'surveillance')),
  severity         text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  current_severity text NOT NULL CHECK (current_severity IN ('info', 'warning', 'critical')),
  mmsi             integer NOT NULL,
  related_mmsi     integer,
  zone_id          uuid,
  geom             geography(Point, 4326),
  title            text NOT NULL,
  message          text NOT NULL,
  method_id        text NOT NULL,
  dedup_key        text NOT NULL,
  data             jsonb NOT NULL DEFAULT '{}',
  status           text NOT NULL CHECK (status IN ('open', 'resolved')),
  opened_at        timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  resolved_at      timestamptz,
  resolution       jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, time)
);

-- create_hypertable also creates the default index events_time_idx (time DESC).
SELECT create_hypertable('events', by_range('time', INTERVAL '7 days'));
SELECT add_retention_policy('events', INTERVAL '2 years');

CREATE INDEX events_open_idx ON events (dedup_key) WHERE status = 'open';
CREATE INDEX events_time_id_idx ON events (time DESC, id DESC);
CREATE INDEX events_mmsi_time_idx ON events (mmsi, time DESC);
CREATE INDEX events_related_mmsi_time_idx ON events (related_mmsi, time DESC) WHERE related_mmsi IS NOT NULL;
CREATE INDEX events_geom_idx ON events USING gist ((geom::geometry));

-- ---------------------------------------------------------------------------
-- Collision encounters (spec §13.7): CPA/TCPA samples of vessel pairs at risk
-- (mmsi_a < mmsi_b), grouped by encounter_id from the first band above none to
-- the return to none. Immutable rows: compressed, explicit retention.
-- ---------------------------------------------------------------------------
CREATE TABLE encounters (
  time         timestamptz NOT NULL,
  mmsi_a       integer NOT NULL,
  mmsi_b       integer NOT NULL,
  encounter_id uuid NOT NULL,
  cpa_nm       double precision NOT NULL CHECK (cpa_nm >= 0),
  tcpa_min     double precision,
  range_nm     double precision NOT NULL CHECK (range_nm >= 0),
  risk         text NOT NULL CHECK (risk IN ('none', 'low', 'medium', 'high')),
  positions    jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mmsi_a, mmsi_b, time),
  CHECK (mmsi_a < mmsi_b)
);

-- create_hypertable also creates the default index encounters_time_idx (time DESC).
SELECT create_hypertable('encounters', by_range('time', INTERVAL '7 days'));
ALTER TABLE encounters SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'mmsi_a, mmsi_b',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('encounters', INTERVAL '14 days');
SELECT add_retention_policy('encounters', INTERVAL '2 years');

CREATE INDEX encounters_mmsi_b_time_idx ON encounters (mmsi_b, time DESC);
CREATE INDEX encounters_encounter_idx ON encounters (encounter_id, time DESC);
