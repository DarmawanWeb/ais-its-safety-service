# Changelog

All notable changes to `ais-its-safety-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `DETECTOR_PINNED_TTL_MS` (default 30 000, the kit's): pinned TTL of the exclusive position
  consumer, also the base of the failover resync gap.
- Metric `aisits_safety_alert_resyncs_total{outcome}`.
- Migration `0002_private_pipelines_open_events`: `vessel_state.nearest_pipeline_org_id`
  (back-filled from the `zones` projection) and the partial index `events_open_time_idx`.

### Changed

- Org-owned pipeline zones are tenant-private (spec §8.5): the `ews` detector measures a vessel
  to the global pipelines and to those of its own organization only. For other tenants the REST
  states show `nearestPipelineZoneId` / `pipelineDistanceM` of an org-owned zone as `null`
  (the EWS status stays shared; authority and super_admin see the zone), and the shared `SAFETY`
  stream always publishes them as `null`. A zone or vessel changing organization resolves the
  EWS alerts that no longer apply.
- Alert data no longer carries owner organizations (`data.orgId` of `ews`, `data.orgIds` of
  `collision`): consumers resolve ownership in their own `FLEET` projection.
- `GET /safety/encounters` is ordered by encounter (newest first, `encounter_id` = UUIDv7 of the
  start) and its cursor keeps the time window of the first page.
- `GET /safety/events?status=open` without `from` lists every open occurrence instead of the last
  7 days only.
- README "Deployment": one replica per deployment with a `Recreate` rollout until the kit hands
  the alert state over on failover; the "hot standby" claim is gone.

### Fixed

- Failover with stale alert state: the kit's `DetectorRunner` loads open alerts only at boot, so a
  standby that took over raised again what the previous instance had raised since (second
  `alert.raised.v1`, second open row) and missed what it had resolved. `AlertStateSync` (local
  workaround) reloads the open alerts of the enabled detectors from `events` on the first position
  after boot and after a gap of half the pinned TTL, waits for running detector calls, forgets
  occurrences resolved elsewhere without writing, restores those opened elsewhere and restarts the
  collision tracker when anything changed.
- `events` keeps one open row per `dedup_key`: every write that opens a row (new alert,
  escalation, reopening) runs under a per-key advisory lock and resolves the other open rows of
  the key as `superseded` (only escalations did before).
- `events.last_seen_at` is event time throughout: the de-escalation / reopening updates no longer
  write the emitter's wall clock, repeats of an unchanged severity are recorded (at most every
  60 s per key), and a resolution sets `resolved_at` only. The collision detector resolves alerts
  whose pair is no longer evaluated by comparing event time with event time (it used the
  emitter's wall-clock `lastSeenAt`, delaying orphan resolution by the feed lag).
- Encounter pages skipped an active encounter that got a new sample between two page requests
  (keyset on its moving latest sample time).

## [0.1.0] - 2026-11-21

### Added

- Navigational safety service (spec §13.7) on the Detector SDK (spec §18): durable
  `safety-positions` on `AIS_POSITION` (a `DETECTORS` subset on `safety-positions-<ids>`, exclusive
  active instance), in-memory `GEO` / `FLEET` projections, alerts published to `ALERTS` after the
  `events` table stored them, open alerts restored at startup.
- Detector `ews` — pipeline Early Warning System with exact parity to the legacy `checkShipStatus`
  (distance to the nearest active `pipeline` zone line with Turf.js 7 semantics, the SDK's
  `'sphere'` model; only vessels predicted at anchor are rated: `< EWS_DANGER_M` (500 m) danger,
  `< EWS_WARNING_M` (1 750 m) warning, else safe); `ews` alerts on the transition to warning /
  danger and on escalation (`dedupKey = ews:<mmsi>:<zoneId>`), resolved when safe again, when
  another pipeline becomes the nearest one or when the zone is removed; golden tests generated once
  from the legacy function (`scripts/golden/generate-ews-golden.mjs`).
- Detector `collision` — CPA/TCPA from relative motion (SOG/COG vectors, local plane, candidates
  dead-reckoned to the position's time; SOG 102.3 / COG 360 = not available), neighbours within
  `COLLISION_SEARCH_RADIUS_NM` seen within `COLLISION_MAX_AGE_S`, exclusions (predicted at anchor,
  moored / at anchor / aground, slow, diverging, same MMSI), risk bands high / medium / low with
  hysteresis, `collision` alerts for high (critical) and medium (warning) with
  `dedupKey = collision:<minMmsi>:<maxMmsi>`, encounter samples in the `encounters` hypertable;
  pure CPA/TCPA functions tested against hand-computed head-on, crossing, overtaking, parallel,
  diverging and stationary-target cases.
- Per-vessel safety state `vessel_state` (detector parts merged, newest part wins) published as
  `safety.vessel_state.updated.v1` to `SAFETY` on a material change and as a heartbeat
  (`SAFETY_STATE_HEARTBEAT_S`), batched writes with retry and backoff.
- Durable projections `safety-zones` / `safety-fleet` into `zones` / `vessels` (newest snapshot
  wins, tombstoned deletions), rebuilt from the compacted streams at every start.
- Endpoints `GET /api/v2/safety/vessels`, `/vessels/:mmsi`, `/events`, `/events/:id`,
  `/encounters`, `/detectors` (`safety:read`, tenancy per spec §8.5) and `/methodology`.
- Domain metrics `aisits_safety_*` (state publication, writer, encounter samples, tracked pairs,
  projection rebuilds); method ids `ews.pipeline_distance_status` and `collision.cpa_tcpa`.
- Unit tests with the `DetectorTestHarness`; integration tests end to end against TimescaleDB /
  PostGIS and NATS containers.

[Unreleased]: https://github.com/DarmawanWeb/ais-its-safety-service/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DarmawanWeb/ais-its-safety-service/releases/tag/v0.1.0
