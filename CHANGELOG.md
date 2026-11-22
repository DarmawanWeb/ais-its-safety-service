# Changelog

All notable changes to `ais-its-safety-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-22

Upgrade to `@darmawanweb/ais-its-contracts` 0.4.0 and `@darmawanweb/ais-its-nest` 0.3.0 (the local
failover and `last_seen_at` workarounds give way to the kit), published alert resolutions, the
web app's backend gaps, and the hardening after the 0.1.0 review. **Deploy after notification
0.4** (it handles `alert.resolved.v1`; older instances skip it).

### Added

- **Published resolutions**: the end of an `ews` or `collision` occurrence is announced as
  `alert.resolved.v1` on the raise's subject `alert.v1.<type>.<mmsi>` (stream `ALERTS`) once
  `ALERT_COOLDOWN_S` since the last raise passed, on deactivation or on a graceful stop; a re-raise
  within the cooldown reopens the occurrence and announces nothing. `safety.events` remains the
  record (REST unchanged).
- **Failover handled by the kit**: an instance becomes active on the first position after it was
  pinned; it reloads the open occurrences from `events` (`loadOpen` with `domain`, `methodId`,
  `firstOccurredAt`, `lastOccurredAt`) before that position. `collision` restarts its pair
  tracker in `onActivated`; `ews` resolves in `onActivated` the open occurrences whose pipeline
  zone was deleted, deactivated or became another organization's while it stood by.
- **Localizable texts** (platform convention): alerts and resolutions carry `messageKey` and
  `messageParams` in their `data` (`safety.ews.anchored_near_pipeline`, `safety.collision.risk`,
  the `…resolved_*` keys, `…escalated` / `…superseded` of replaced events); the English `title` /
  `message` are unchanged. Distances are params in whole metres (`cpaM`, `rangeM`, `minCpaM`, the
  cross-service convention) next to the nautical miles of the English sentence (`cpaNm`, `rangeNm`,
  `minCpaNm`). README table "Localizable texts".
- REST: `vessel` / `relatedVessel` on safety events and `vesselA` / `vesselB` on encounters
  (`{ id, name, typeCode }` from the `vessels` projection, shared across tenants); `typeCode` on the
  vessel identity of safety states; `nearestPipeline` `{ id, code, name }` on safety states (hidden
  like `pipelineDistanceM`); encounters gain `messageKey` / `messageParams`, `history[].cpaPositions`
  (predicted positions at the CPA, method `collision.cpa_tcpa`) and the filters `active` and
  `bbox`. `active=true` keeps the newest encounter of each pair whose latest sample is above `none`
  and at most `COLLISION_MAX_AGE_S` + `COLLISION_SAMPLE_INTERVAL_S` + 30 s older than the collision
  detector's event clock (the AIS time of its newest evaluation, never later than the request
  time); an encounter followed by a newer one of its pair (a takeover or restart) has ended. The
  cursor keeps the cut-off.
- `DETECTOR_PINNED_TTL_MS` (default 30 000, the kit's): pinned TTL of the exclusive position
  consumer, i.e. the failover time when the active instance dies.
- Migration `0002_private_pipelines_open_events`: `vessel_state.nearest_pipeline_org_id`
  (back-filled from the `zones` projection) and the partial index `events_open_time_idx`.
- Migration `0003_collision_clock`: the partial index `vessel_state_collision_evaluated_idx`, from
  which `GET /safety/encounters?active` reads the collision detector's event clock.
- Tests: two-instance failover on the kit's activation (graceful stop, reload before the first
  position, nothing raised twice, stream contents by event type), resolution timing with the real
  runner (`test/resolutions.int.test.ts`), active encounters across a takeover and with AIS time
  behind the wall clock (`test/encounters.int.test.ts`), harness tests for resolution events,
  activation and standby, `onRepeated`, texts, CPA positions and active encounters, the sanitized
  log of a failed projection rebuild.

### Changed

- Dependencies: contracts `^0.4.0`, kit `^0.3.0`; the direct `prom-client` dependency is gone
  (metric types from `@darmawanweb/ais-its-nest/metrics`); `.pnpmfile.cjs` keeps the `@nestjs/terminus`
  gRPC peers and TypeScript out of the production install (no testcontainers, dockerode, ssh2,
  `@grpc/grpc-js` or protobufjs in the image).
- **Deployment**: two or more replicas per deployment with rolling updates (a graceful stop
  releases the pin, a standby takes over at once); the one-replica / `Recreate` guidance and the
  resync gap of `DETECTOR_PINNED_TTL_MS / 2` are gone. The platform chart
  (`infra/helm/ais-its-platform`) still runs one replica with `Recreate` until it is updated
  centrally (README "Deployment: replicas and failover"). `DETECTOR_PINNED_TTL_MS` accepts
  3 000–300 000 (was 2 000; below 3 s the pin may be lost while idle).
- Ticks (collision housekeeping) run only on the active instance; zone and vessel changes resolve
  `ews` alerts only there.
- `events.last_seen_at` follows the kit's `onRepeated` (at most every 60 s of event time per key)
  and the event time of de-escalations and reopenings (`update.occurredAt`), never moving back.
  The collision housekeeping compares `OpenAlert.lastOccurredAt` (event time) with the feed's
  event time, with a grace window from the first position of the active period.
- Path parameters use the kit's `@MmsiParam()` / `@UuidParam()` (`400 VALIDATION_FAILED` with
  `field: 'mmsi'` / `'id'`, documented as `^[0-9]{9}$` / `uuid` in OpenAPI); migrations are read
  from the package's `migrations/` (`MIGRATIONS_DIR`) wherever the process starts; database errors
  in the service's own logs are sanitized (`sanitizeError`, no bound values: encounter samples,
  state writes, the projection rebuild at startup).
- Org-owned pipeline zones are tenant-private (spec §8.5): the `ews` detector measures a vessel
  to the global pipelines and to those of its own organization only. For other tenants the REST
  states show `nearestPipelineZoneId` / `nearestPipeline` / `pipelineDistanceM` of an org-owned
  zone as `null` (the EWS status stays shared; authority and super_admin see the zone), and the
  shared `SAFETY` stream always publishes them as `null`. A zone or vessel changing organization
  resolves the EWS alerts that no longer apply.
- Alert data no longer carries owner organizations (`data.orgId` of `ews`, `data.orgIds` of
  `collision`): consumers resolve ownership in their own `FLEET` projection.
- `GET /safety/encounters` is ordered by encounter (newest first, `encounter_id` = UUIDv7 of the
  start) and its cursor keeps the time window of the first page.
- `GET /safety/events?status=open` without `from` lists every open occurrence instead of the last
  7 days only.
- `openapi.json`: page maximum, path parameter schemas, declared security schemes (kit 0.3).

### Removed

- The local workarounds for kit 0.2: `AlertStateSync` / `DETECTOR_GATE`
  (`src/detectors/alert-state-sync.ts`), `AlertSightings` / `ALERT_SIGHTINGS`
  (`src/detectors/alert-sightings.ts`), the `RESOLVED_ELSEWHERE` resolution and
  `DetectorEventsRepository.recordSighting`; the duplicate `DetectorEventsRepository` provider
  (`persistence: { useClass }` provides it); `src/db/errors.ts` (kit `isUniqueViolation`) and the
  local `MmsiParam` / `EventIdParam` DTOs.

### Fixed

- Failover with stale alert state: a standby that took over raised again what the previous
  instance had raised since its boot (second `alert.raised.v1`, second open row) and missed what it
  had resolved; the kit now reloads the open occurrences on every activation (see Added).
- A standby resolved `ews` alerts of its boot-time state on zone and vessel changes.
- `events` keeps one open row per `dedup_key`: every write that opens a row (new alert,
  escalation, reopening) runs under a per-key advisory lock and resolves the other open rows of
  the key as `superseded` (only escalations did before).
- `events.last_seen_at` is event time throughout: the de-escalation / reopening updates no longer
  write the emitter's wall clock, repeats of an unchanged severity are recorded, and a resolution
  sets `resolved_at` only.
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

[Unreleased]: https://github.com/DarmawanWeb/ais-its-safety-service/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/DarmawanWeb/ais-its-safety-service/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DarmawanWeb/ais-its-safety-service/releases/tag/v0.1.0
