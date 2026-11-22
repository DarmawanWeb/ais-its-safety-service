-- 0002_private_pipelines_open_events — review fixes of 0.1.0 (CHANGELOG [Unreleased]).
--
-- Forward-only like 0001: never edit once applied, add 0003_<change>.sql instead.

-- Owner of the nearest pipeline zone (NULL = global zone, spec §8.5). Org-owned pipelines only
-- apply to that organization's vessels; their identity and distance are hidden from other
-- tenants in the REST API and never published to the shared SAFETY stream.
ALTER TABLE vessel_state ADD COLUMN nearest_pipeline_org_id uuid;

-- States written by 0.1.0 take the owner from the GEO projection (tombstones included).
UPDATE vessel_state AS s
SET nearest_pipeline_org_id = z.org_id
FROM zones AS z
WHERE z.id = s.nearest_pipeline_zone_id AND z.org_id IS NOT NULL;

-- GET /safety/events?status=open (without `from`) reads every open occurrence, newest first.
CREATE INDEX events_open_time_idx ON events (time DESC, id DESC) WHERE status = 'open';
