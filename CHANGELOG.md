# Changelog

All notable changes to `ais-its-safety-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
