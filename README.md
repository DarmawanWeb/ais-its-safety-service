# ais-its-safety-service

Navigational safety analytics of **AIS Maritime Intelligence** v2: the pipeline Early Warning
System (EWS) and collision risk from CPA/TCPA, built on the Detector SDK of
[`@darmawanweb/ais-its-nest`](https://github.com/DarmawanWeb/ais-its-contracts/tree/main/packages/nest)
(`./analytics`). Service `safety`, port `3011`, PostgreSQL schema `safety` (TimescaleDB + PostGIS),
NATS JetStream. The normative engineering spec is `docs/PLATFORM_SPEC.md` (§13.7, §18) in the central
repository [`ais-its-platform`](https://github.com/DarmawanWeb/ais-its-platform).

## Purpose and responsibilities

- **Detectors** on the live AIS feed (`AIS_POSITION`), one class each under `src/detectors/<id>/`:
  - `ews` — pipeline Early Warning System with exact parity to the legacy `checkShipStatus`: a
    vessel **predicted at anchor** closer than 500 m to an active `pipeline` zone line is in danger
    (`0`, critical alert), closer than 1 750 m warned (`1`, warning alert), otherwise safe (`3`).
    The pipelines are the global zones plus those of the vessel's own organization (org-owned
    zones are tenant-private, spec §8.5).
  - `collision` — CPA/TCPA of vessel pairs from relative motion, risk bands `high` / `medium` /
    `low` with hysteresis, alerts for `high` (critical) and `medium` (warning), encounter history.
- **Per-vessel safety state** (`vessel_state`): latest position, EWS status, pipeline distance,
  collision risk and closest encounter, published to the `SAFETY` stream on change and as a
  heartbeat. This service is the producer of `SAFETY` and of its detectors' `ALERTS`.
- **Detector events** (`events` hypertable): every published alert and its lifecycle
  (open → resolved), at most one open row per `dedup_key`; the open rows are restored at startup
  and reloaded when this instance takes over from another one, so neither a restart nor a
  failover raises an open alert again or misses one resolved elsewhere.
- **REST API** `/api/v2/safety/*` for the live map (initial safety states), the safety pages of the
  web app (events, encounters) and traceability (detectors, methodology).

Not here: AIS decoding and navstatus prediction (ais-pipeline), zones (geo), vessels (fleet), alert
inbox, rules and delivery (notification), illegal-activity detectors (surveillance).

## Architecture

```mermaid
flowchart LR
  subgraph NATS["NATS JetStream"]
    AISP["AIS_POSITION<br/>ais.position.v1.{p}.{mmsi}"]
    GEO["GEO (compacted)<br/>geo.zone.v1.{zoneId}"]
    FLEET["FLEET (compacted)<br/>fleet.vessel.v1.{vesselId}"]
    SAFETY["SAFETY<br/>safety.state.v1.{mmsi}"]
    ALERTS["ALERTS<br/>alert.v1.{type}.{mmsi}"]
  end
  subgraph SVC["safety :3011"]
    RUN["DetectorRunner<br/>(durable safety-positions, exclusive)"]
    SYNC["AlertStateSync<br/>(reload open alerts on takeover)"]
    IDX["ZoneIndex / FleetDirectory<br/>VesselStateStore / PairSearch"]
    EWS["ews detector"]
    COL["collision detector<br/>+ EncounterTracker"]
    EMIT["AlertEmitter"]
    WRITER["SafetyStateWriter<br/>(merge, batch, publish)"]
    PROJ["ProjectionsConsumer<br/>(safety-zones, safety-fleet)<br/>+ startup rebuild"]
    API["REST /api/v2/safety/*"]
  end
  subgraph PG["PostgreSQL schema safety"]
    VS[(vessel_state)]
    EV[(events hypertable)]
    EN[(encounters hypertable)]
    PZ[(zones, vessels projections)]
  end
  AISP --> RUN --> SYNC --> EWS & COL
  EV -- open rows --> SYNC
  SYNC -- restore / forget --> EMIT
  GEO -- ordered, last per subject --> IDX
  FLEET -- ordered, last per subject --> IDX
  IDX --> EWS & COL
  EWS & COL -- raise / resolve --> EMIT
  EMIT -- persist first (1 open row per key) --> EV
  EWS & COL -- sightings (last_seen_at) --> EV
  EMIT -- alert.raised.v1 --> ALERTS
  EWS & COL -- state parts --> WRITER
  WRITER --> VS
  WRITER -- safety.vessel_state.updated.v1 --> SAFETY
  COL -- samples --> EN
  GEO & FLEET --> PROJ --> PZ
  API --> VS & EV & EN & PZ
```

Startup follows the kit's lifecycle rule: connect, migrate and ensure the produced streams
(`SAFETY`, `ALERTS`) in `onModuleInit` → restore open alerts, load the `GEO` / `FLEET` snapshots,
rebuild the `zones` / `vessels` tables, start the durable consumers and the ticks in
`onApplicationBootstrap` → the port opens. On `SIGTERM` readiness turns `503`, consumers drain, the
state writer flushes, NATS drains and the pool closes.

| Path                                          | What                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/detectors/ews/`                          | `EwsDetector`, `EWS_*` config, golden parity tests with the legacy `checkShipStatus`            |
| `src/detectors/collision/`                    | `CollisionDetector`, `COLLISION_*` config, `EncounterTracker` (bands, encounter ids)            |
| `src/detectors/detectors.module.ts`           | Detector SDK wiring (`DetectorRunnerModule`, `'sphere'` distances, pair search grid)            |
| `src/detectors/detector-events.repository.ts` | `AlertPersistence` hook: the `events` table (one open row per key, event-time `last_seen_at`)   |
| `src/detectors/alert-state-sync.ts`           | failover workaround: reloads the open alerts when the instance starts consuming                 |
| `src/detectors/alert-sightings.ts`            | `last_seen_at` of conditions whose severity holds                                               |
| `src/domain/`                                 | pure functions with `@method` TSDoc: `ews.ts`, `cpa.ts`, `collision-risk.ts`, `safety-state.ts` |
| `src/modules/vessel-states/`                  | `SafetyStateWriter` (producer of `SAFETY`), `GET /safety/vessels[/:mmsi]`                       |
| `src/modules/events/`                         | `GET /safety/events[/:id]`                                                                      |
| `src/modules/encounters/`                     | encounter recorder (detector sink) and `GET /safety/encounters`                                 |
| `src/modules/methodology/`                    | `GET /safety/methodology` from the contracts catalog                                            |
| `src/consumers/`                              | durable `GEO` / `FLEET` projections into `zones` / `vessels`, startup rebuild                   |
| `src/common/`                                 | tenancy scope (spec §8.5), domain metrics, `:mmsi` parameter                                    |
| `migrations/`                                 | forward-only SQL migrations                                                                     |
| `test/`                                       | integration tests against TimescaleDB/PostGIS and NATS containers                               |

### How a position flows

1. The runner receives `ais.position.recorded.v1` on the durable `safety-positions` (one active
   instance, `exclusive`), updates `VesselStateStore` and `PairSearch` (older or duplicate positions
   are dropped) and calls every enabled detector (`DETECTOR_CONCURRENCY` vessels in parallel, one
   vessel's positions in order). The detectors run through `AlertStateSync`: the first position
   after boot or after a gap of `DETECTOR_PINNED_TTL_MS / 2` first reloads the open alerts from
   `events` (see [Deployment](#deployment-one-active-instance-per-durable)).
2. `ews` measures the distance to the nearest active `pipeline` zone line that applies to the
   vessel — global zones and its organization's own (Turf.js semantics, metres) — and classifies it; `collision` queries the neighbours within `COLLISION_SEARCH_RADIUS_NM`
   seen within `COLLISION_MAX_AGE_S`, aligns the candidate to the position's time (dead reckoning),
   computes CPA/TCPA and the band with hysteresis.
3. Each detector raises or resolves its alerts through the `AlertEmitter` (one state machine per
   `dedupKey`: raised → escalated → de-escalated / unchanged / suppressed → resolved) — the hook
   writes `events` **before** `alert.raised.v1` is published — and reports its part of the vessel's
   safety state to the `SafetyStateWriter`.
4. The writer merges the parts per vessel (newest of each part wins, so detectors deployed
   separately complete each other's state), upserts `vessel_state` in batches every
   `SAFETY_STATE_FLUSH_MS` and publishes `safety.vessel_state.updated.v1` when the state changed
   materially, otherwise at most every `SAFETY_STATE_HEARTBEAT_S` of event time.

## Data model

Schema `safety`, owned by `safety_svc`; migrations in [`migrations/`](migrations) are forward-only
and checksummed (never edit an applied file — add `NNNN_<change>.sql`).

| Table          | Kind                                   | Content                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vessel_state` | table, PK `mmsi`, GiST on `geom`       | latest position (`time, geom, sog, cog, hdg, navstatus, pred_navstatus`), EWS part (`ews_status, pipeline_dist_m, nearest_pipeline_zone_id, nearest_pipeline_org_id, ews_evaluated_at`), collision part (`collision_risk, closest_encounter jsonb, collision_evaluated_at`), `evaluated_at`, last published state (`published_state`, `published_at`)           |
| `events`       | hypertable on `time` (7-day chunks)    | one row per published alert: `id` (= alert id), `detector, type, domain, severity, current_severity, mmsi, related_mmsi, zone_id, geom, title, message, method_id, dedup_key, data, status ('open','resolved'), opened_at, last_seen_at, resolved_at, resolution`; retention 2 years, not compressed (rows change until resolved); partial indexes on open rows |
| `encounters`   | hypertable on `time` (7-day chunks)    | CPA/TCPA samples of pairs at risk: `mmsi_a < mmsi_b, encounter_id, cpa_nm, tcpa_min, range_nm, risk, positions jsonb`; PK `(mmsi_a, mmsi_b, time)`; compressed after 14 days (`segmentby mmsi_a, mmsi_b`), retention 2 years                                                                                                                                    |
| `zones`        | projection of `GEO` (`safety-zones`)   | zone snapshots (`geom geography`, kind, active, …), newest snapshot wins, deletions tombstoned (`deleted_at`)                                                                                                                                                                                                                                                   |
| `vessels`      | projection of `FLEET` (`safety-fleet`) | `mmsi → org_id` and identity for tenancy and vessel names; one live vessel per MMSI                                                                                                                                                                                                                                                                             |

An escalation (warning → critical) publishes a new alert id for the same `dedup_key` and resolves
the superseded row (`resolution.reason = 'escalated'`). Every write that opens a row (new alert,
escalation, reopening within the cooldown) runs under a per-key advisory lock and resolves any other
open row of the key (`'superseded'`), so a key never has two open rows. `time`, `opened_at`,
`last_seen_at` and `resolved_at` are event (AIS) time: `last_seen_at` follows the repeats of an
unchanged condition at most every 60 s and is not moved by the resolution.
`nearest_pipeline_org_id` (migration `0002`) records the owner of an org-owned pipeline zone: the
REST API shows that zone and its distance to the owner and to authorities only, and the shared
`SAFETY` stream never carries them. Encounters group samples by `encounter_id`
from the first band above `none` to the return to `none`; an unchanged band is sampled at most every
`COLLISION_SAMPLE_INTERVAL_S`.

## API

Routes live under `/api/v2` (OpenAPI: `/docs`, `/openapi.json`, committed as
[`openapi.json`](openapi.json)); errors are RFC 9457 problem details (`application/problem+json`,
stable `code`). Every route requires a signed-in user (global default-deny guard).

| Method | Path                            | Permission                         | What                                                                                                                                                                                                     |
| ------ | ------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v2/safety/vessels`        | `safety:read`                      | latest safety states `?bbox&ewsStatus=0,1&collisionRisk=medium,high&since&limit` (array, by MMSI; default: positions of the last 24 h, ≤ 5 000)                                                          |
| GET    | `/api/v2/safety/vessels/:mmsi`  | `safety:read`                      | one vessel's state; `404 SAFETY_STATE_NOT_FOUND`                                                                                                                                                         |
| GET    | `/api/v2/safety/events`         | `safety:read`                      | detector events `?detector&severity&status&mmsi&from&to&bbox&cursor&limit`, newest first (default 7 days, ≤ 366 days; `status=open` without `from`: every open occurrence), cursor page                  |
| GET    | `/api/v2/safety/events/:id`     | `safety:read`                      | one event; `404 SAFETY_EVENT_NOT_FOUND` (also outside the tenancy)                                                                                                                                       |
| GET    | `/api/v2/safety/encounters`     | `safety:read`                      | collision encounters with CPA/TCPA history `?from&to&risk&mmsi&encounterId&cursor&limit` (newest encounter first, default 24 h, ≤ 31 days; `risk` = peak band; the cursor keeps the first page's window) |
| GET    | `/api/v2/safety/detectors`      | `safety:read`                      | detectors of this instance: enabled, method ids, active thresholds                                                                                                                                       |
| GET    | `/api/v2/safety/methodology`    | any signed-in user                 | methods implemented here with their catalog entries and references                                                                                                                                       |
| GET    | `/health/live`, `/health/ready` | public                             | liveness; readiness (database, NATS)                                                                                                                                                                     |
| GET    | `/metrics`                      | public (not routed by the gateway) | Prometheus metrics                                                                                                                                                                                       |

Tenancy (spec §8.5): safety **states** are shared across tenants, except the nearest pipeline when
it is an org-owned zone: `nearestPipelineZoneId` and `pipelineDistanceM` are `null` for readers
outside that organization (authority and super_admin see them; the EWS status stays shared).
Org-owned pipeline zones only apply to their organization's vessels, so their alerts reach that
organization alone; alert data carries no owner organizations. **Events and encounters** are
visible to `authority` and `super_admin` in full; other roles see only those whose `mmsi` or
`relatedMmsi` (encounters: either vessel) belongs to a vessel of their active organization, from the
`vessels` projection of `FLEET` — the organization comes from the token, never from the request. A
principal without an organization sees none.

## Events

| Direction | Stream / subject                          | Event type                                            | Consumer / notes                                                                                                                                |
| --------- | ----------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| consumes  | `AIS_POSITION` / `ais.position.v1.>`      | `ais.position.recorded.v1`                            | durable **`safety-positions`** (a `DETECTORS` subset: `safety-positions-<sorted ids>`), exclusive, detector feed                                |
| consumes  | `GEO` / `geo.zone.v1.>`                   | `geo.zone.upserted.v1`, `geo.zone.deleted.v1`         | durable **`safety-zones`** → `zones` table; ordered `safety-geo-projection` → `ZoneIndex`; ordered `safety-zones-rebuild` at startup            |
| consumes  | `FLEET` / `fleet.vessel.v1.>`             | `fleet.vessel.upserted.v1`, `fleet.vessel.deleted.v1` | durable **`safety-fleet`** → `vessels` table; ordered `safety-fleet-projection` → `FleetDirectory`; ordered `safety-vessels-rebuild` at startup |
| produces  | `SAFETY` / `safety.state.v1.<mmsi>`       | `safety.vessel_state.updated.v1`                      | on a material change and as a heartbeat (`SAFETY_STATE_HEARTBEAT_S`); consumed by notification (`notification-safety`)                          |
| produces  | `ALERTS` / `alert.v1.ews.<mmsi>`          | `alert.raised.v1` (`type: ews`)                       | on the transition to warning / danger and on escalation; `dedupKey = ews:<mmsi>:<zoneId>`; consumed by `notification-alerts`                    |
| produces  | `ALERTS` / `alert.v1.collision.<minMmsi>` | `alert.raised.v1` (`type: collision`)                 | on `medium` (warning) / `high` (critical) and on escalation; `dedupKey = collision:<minMmsi>:<maxMmsi>`, `relatedMmsi` = the other vessel       |
| produces  | `DLQ` / `dlq.<stream>.<consumer>`         | copy of a failed message                              | after `max_deliver` (10) failed deliveries of a durable consumer (kit)                                                                          |

Invalid messages are terminated and counted (`aisits_events_invalid_total`); all handlers are
idempotent (projections: newest snapshot wins; detectors: positions not newer than the vessel's
state are dropped, alerts are state machines per `dedupKey`; event rows insert on conflict do
nothing). Resolutions are not published as events: they are stored in `events` (the notification
service merges alerts by `dedupKey` while open).

Payload examples (`data` of the envelope):

```jsonc
// safety.vessel_state.updated.v1 (shared: an org-owned nearest pipeline is published as null / null)
{ "mmsi": 525005223, "time": "2026-11-21T10:00:10.000Z", "ewsStatus": 1, "pipelineDistanceM": 1000.2,
  "nearestPipelineZoneId": "0193…", "collisionRisk": "none", "closestEncounter": null,
  "methodIds": ["ews.pipeline_distance_status", "collision.cpa_tcpa"] }
// alert.raised.v1 (ews)
{ "type": "ews", "domain": "safety", "severity": "warning", "mmsi": 525005223, "zoneId": "0193…",
  "dedupKey": "ews:525005223:0193…", "methodId": "ews.pipeline_distance_status",
  "data": { "methodId": "ews.pipeline_distance_status", "ewsStatus": 1, "pipelineDistanceM": 1000.2,
            "zoneId": "0193…", "thresholds": { "dangerM": 500, "warningM": 1750 }, … } }
// alert.raised.v1 (collision)
{ "type": "collision", "severity": "critical", "mmsi": 525005223, "relatedMmsi": 525005224,
  "dedupKey": "collision:525005223:525005224", "methodId": "collision.cpa_tcpa",
  "data": { "risk": "high", "cpaNm": 0.08, "tcpaMin": 2.1, "rangeNm": 0.7, "encounterId": "0193…",
            "thresholds": { "high": { "cpaNm": 0.25, "tcpaMin": 6 }, …, "hysteresis": 0.2 }, … } }
```

## Configuration

Every variable is listed with its development default in [`.env.example`](.env.example); the
service refuses to start on invalid values (including invalid `EWS_*` / `COLLISION_*` values or an
unknown `DETECTORS` entry) and prints every problem.

| Variable                                                | Default                                                  | Notes                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                              | `development`                                            | `development` \| `test` \| `production`                                                                             |
| `SERVICE_NAME`                                          | `safety`                                                 | logs, metrics, event `source`, consumer names                                                                       |
| `SERVICE_VERSION`                                       | `package.json` version                                   |                                                                                                                     |
| `HOST` / `PORT`                                         | `0.0.0.0` / `3011`                                       | spec §3                                                                                                             |
| `LOG_LEVEL` / `LOG_PRETTY`                              | `info` / `true` in development                           | pino JSON otherwise                                                                                                 |
| `SHUTDOWN_TIMEOUT_MS`                                   | `30000`                                                  | graceful shutdown deadline                                                                                          |
| `DATABASE_URL`                                          | `postgres://safety_svc:safety_svc@localhost:5432/aisits` | role `safety_svc`                                                                                                   |
| `DATABASE_SCHEMA`                                       | `safety`                                                 | `search_path=safety,public`                                                                                         |
| `DATABASE_POOL_MAX`                                     | `10`                                                     |                                                                                                                     |
| `DATABASE_STATEMENT_TIMEOUT_MS`                         | `30000`                                                  |                                                                                                                     |
| `DB_MIGRATE_ON_BOOT`                                    | `true`                                                   | also `pnpm migrate`                                                                                                 |
| `NATS_URL`                                              | `nats://localhost:4222`                                  | comma separated list allowed                                                                                        |
| `NATS_DURABLE_PREFIX`                                   | empty                                                    | prefix of durable consumer names (tests)                                                                            |
| `AUTH_JWKS_URL`                                         | `http://localhost:3001/.well-known/jwks.json`            | access tokens are verified locally (cached JWKS)                                                                    |
| `AUTH_ISSUER` / `AUTH_AUDIENCE`                         | `ais-its-auth` / `ais-its-api`                           |                                                                                                                     |
| `AUTH_INTERNAL_URL`                                     | `http://localhost:3001`                                  | API-key introspection (no route of this service accepts API keys)                                                   |
| `INTERNAL_TOKEN`                                        | `dev-internal-token-change-me`                           | ≥ 16 characters and changed in production                                                                           |
| `CORS_ORIGINS`                                          | `http://localhost:5173,http://localhost:8000`            |                                                                                                                     |
| `TRUSTED_PROXIES`                                       | `loopback,linklocal,uniquelocal`                         | set the gateway's address/CIDR in production                                                                        |
| `PUBLIC_BASE_URL`                                       | `http://localhost:8000`                                  |                                                                                                                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                           | unset                                                    | OTLP/HTTP tracing when set                                                                                          |
| `SAFETY_STATE_HEARTBEAT_S`                              | `300`                                                    | longest interval (event time) between two publications of an unchanged state (10–86 400)                            |
| `SAFETY_STATE_FLUSH_MS`                                 | `250`                                                    | batching interval of the state writer (20–10 000)                                                                   |
| `DETECTOR_CONCURRENCY`                                  | `8`                                                      | vessels evaluated in parallel (1–64)                                                                                |
| `DETECTOR_PINNED_TTL_MS`                                | `30000`                                                  | pinned TTL of the exclusive position consumer (2 000–300 000); half of it without positions reloads the open alerts |
| `ALERT_COOLDOWN_S`                                      | `600`                                                    | AlertEmitter cooldown: no re-publication of a key's severity within it                                              |
| `PROJECTION_CATCH_UP_TIMEOUT_MS`                        | `60000`                                                  | how long startup waits for the `GEO` / `FLEET` snapshots                                                            |
| `DETECTORS`                                             | all (`ews,collision`)                                    | comma separated subset run by this instance                                                                         |
| `EWS_DANGER_M`                                          | `500`                                                    | danger distance, m (legacy)                                                                                         |
| `EWS_WARNING_M`                                         | `1750`                                                   | warning distance, m (legacy); must exceed `EWS_DANGER_M`                                                            |
| `COLLISION_SEARCH_RADIUS_NM`                            | `6`                                                      | candidate radius, nm (≤ 50)                                                                                         |
| `COLLISION_MAX_AGE_S`                                   | `120`                                                    | candidates seen within this window, s (≤ 600)                                                                       |
| `COLLISION_MIN_SOG_KN`                                  | `0.5`                                                    | slower vessels are excluded, kn                                                                                     |
| `COLLISION_HIGH_CPA_NM` / `COLLISION_HIGH_TCPA_MIN`     | `0.25` / `6`                                             | band `high` (critical alert)                                                                                        |
| `COLLISION_MEDIUM_CPA_NM` / `COLLISION_MEDIUM_TCPA_MIN` | `0.5` / `12`                                             | band `medium` (warning alert)                                                                                       |
| `COLLISION_LOW_CPA_NM` / `COLLISION_LOW_TCPA_MIN`       | `1` / `20`                                               | band `low` (state only); limits must grow from high to low                                                          |
| `COLLISION_HYSTERESIS`                                  | `0.2`                                                    | a pair keeps its band until it leaves the limits widened by this fraction                                           |
| `COLLISION_SAMPLE_INTERVAL_S`                           | `30`                                                     | minimum interval between two stored samples of an unchanged encounter (0 = every evaluation)                        |

`REDIS_URL` is part of the platform base schema but not used: detector state lives in memory.

### Deployment: one active instance per durable

Detector state (vessel states, neighbours, encounters, open alerts) lives in memory, so positions go
to **one active instance per durable** (`exclusive`, NATS priority group `pinned_client`): another
replica of the same deployment only takes over once the active one pulled nothing for
`DETECTOR_PINNED_TTL_MS`.

**Run one replica per deployment, with a `Recreate` (no-surge) rollout** (Kubernetes
`strategy: Recreate`; compose restarts the container in place). The kit (`@darmawanweb/ais-its-nest`
0.2.0) restores open alerts only at boot and does not reload them when a standby becomes active, so
this service works around it (`src/detectors/alert-state-sync.ts`): the first position after boot,
and the first after a gap of `DETECTOR_PINNED_TTL_MS / 2` without positions — every takeover has
one — waits for running detector calls, reloads the open alerts of its detectors from `events`
(forgets those resolved elsewhere, restores those raised elsewhere) and, when anything changed,
restarts the collision tracker from the open alerts. A second replica therefore works as a standby,
but two cases remain until the kit hands the state over itself: the old instance may still finish
the positions it had pulled while the new one starts (the one-open-row-per-key invariant bounds
the effect to a repeated publication), and two pin moves within the gap (NATS server restarts) are
not detected. A quiet feed (no positions for half the TTL) costs one indexed query of open rows.

### Deployment: one deployment per detector

To spread the load, split the detectors over deployments with `DETECTORS`: each subset consumes through its
own durable, both write their part of `vessel_state` (the parts merge) and both serve the REST API.

```yaml
# docker compose (excerpt) — same image, two deployments
safety-ews:
  image: ghcr.io/darmawanweb/ais-its-safety-service:0.1.0
  environment:
    DETECTORS: ews # durable safety-positions-ews
    EWS_DANGER_M: '500'
    EWS_WARNING_M: '1750'
safety-collision:
  image: ghcr.io/darmawanweb/ais-its-safety-service:0.1.0
  environment:
    DETECTORS: collision # durable safety-positions-collision
    COLLISION_SEARCH_RADIUS_NM: '6'
    DETECTOR_CONCURRENCY: '16'
```

`GET /safety/detectors` of each deployment lists the detector it runs (`enabled: true`) and the
other one disabled. The gateway route `/api/v2/safety` can point at either deployment.

## Local development

Requirements: Node.js 24 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker. `@darmawanweb/*` packages
come from GitHub Packages: map the scope once in `~/.npmrc` (never in this repository):

```ini
@darmawanweb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

```bash
pnpm install
cp .env.example .env
pnpm --dir <central repo> infra:up     # postgres, nats, … (or any reachable instances)
pnpm dev                               # watch mode (SWC, decorator metadata)
curl -s localhost:3011/health/ready
open http://localhost:3011/docs        # Swagger UI
```

| Script                                          | What                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm dev`                                      | watch mode (`nest start --watch --builder swc`)                         |
| `pnpm build` / `pnpm start`                     | compile with `tsc` to `dist/` / run it                                  |
| `pnpm start:prod`                               | run `dist/` with `NODE_ENV=production`                                  |
| `pnpm migrate`                                  | apply `migrations/` (also on boot when `DB_MIGRATE_ON_BOOT=true`)       |
| `pnpm openapi`                                  | build, then write `openapi.json` without any infrastructure (commit it) |
| `pnpm openapi:check`                            | fail when the committed `openapi.json` differs from `dist/` (CI)        |
| `pnpm test` / `pnpm test:int` / `pnpm test:all` | unit tests / integration tests (Docker) / both                          |
| `pnpm lint` / `pnpm typecheck` / `pnpm format`  | ESLint, `tsc --noEmit`, Prettier                                        |

To try the detectors locally, publish a `pipeline` zone (`geo.zone.upserted.v1`) and positions
(`ais.position.recorded.v1` with `predictedNavstatus: 1` near the line) to NATS, e.g. with the kit's
`makeTestZone()` / `toPositionPayload()` helpers, then watch `GET /api/v2/safety/vessels` and the
`ALERTS` stream (`nats stream view ALERTS`).

## Testing

- **Unit tests** (`pnpm test`, no Docker) next to the code:
  - `src/domain/cpa.spec.ts` — CPA/TCPA against hand-computed cases: head-on, crossing (collision
    course and passing ahead), overtaking, parallel (no relative motion), diverging (TCPA < 0),
    stationary target, symmetry; SOG 102.3 / COG 360 as not available.
  - `src/domain/collision-risk.spec.ts`, `ews.spec.ts`, `safety-state.spec.ts` — bands, hysteresis,
    exclusions, EWS classification, state merge and publication rule.
  - `src/detectors/ews/ews.golden.spec.ts` — **golden parity**: 21 cases produced once by running the
    legacy `checkShipStatus` verbatim with Turf.js 7.2.0 against the legacy `data/pipeline.json`
    ([`scripts/golden/generate-ews-golden.mjs`](scripts/golden/generate-ews-golden.mjs), fixture in
    `src/detectors/ews/__fixtures__/`), both thresholds from both sides within 0.2 m; distances agree
    to 1e-5 m.
  - `src/detectors/*/*.detector.spec.ts` — both detectors through the SDK's `DetectorTestHarness`
    (alerts, no repeats, escalation, de-escalation, resolution, ticks, configuration).
  - `src/modules/vessel-states/safety-state.writer.spec.ts` — batching, heartbeat, retries.
  - `src/detectors/alert-state-sync.spec.ts` — the failover resync on the harness's real emitter:
    when it reloads, forgetting alerts resolved elsewhere, restoring alerts raised elsewhere,
    resets only on changes, failure and retry, waiting for running calls;
    `alert-sightings.spec.ts` — `last_seen_at` throttling; `src/common/tenancy.spec.ts` — scopes
    and the visibility of org-owned pipelines.
- **Integration tests** (`pnpm test:int`, Docker): the real `AppModule` against
  `timescale/timescaledb-ha:pg17` and `nats:2.11-alpine` started once by
  `test/support/global-setup.ts`, signed test JWTs:
  - `test/safety.int.test.ts` — zones (GEO) and positions (AIS_POSITION) published to NATS → safety
    states on `SAFETY`, `alert.raised.v1` for EWS warning and danger and for a crossing encounter,
    no repeats while unchanged, resolutions in `events`, encounter history, REST queries and tenancy.
  - `test/projections.int.test.ts` — projection rebuild from the compacted streams, tombstones,
    `DETECTORS` subset on its own durable.
  - `test/app.int.test.ts` — health, migrations, auth, OpenAPI, metrics.
  - `test/failover.int.test.ts` — two instances on one durable (pinned TTL 3 s): after the
    takeover the standby raises again what the active instance resolved meanwhile and does not
    raise again what it raised (one open row), then resolves it.
  - `test/tenancy.int.test.ts` — an org-owned pipeline: no EWS for another organization's vessel;
    the owner's vessel is warned, the zone and distance are `null` on `SAFETY` and in REST for
    other tenants, the event is visible to the owner only, no owner organizations in alert data.
  - `test/events.int.test.ts` — one open row per key (supersede on raise and reopen, no write for
    resolutions learnt elsewhere), `last_seen_at` / `resolved_at` in event time, `status=open`
    beyond the 7-day default, encounter pages that never skip an encounter getting new samples.

## Operations

- Image `ghcr.io/darmawanweb/ais-its-safety-service` (CI pushes `main` and `sha-<commit>`, releases
  push `<version>`, `<major>.<minor>` and `latest`): `node:24-alpine`, non-root `node`,
  `NODE_ENV=production`, `HEALTHCHECK` on `/health/live`. Local build:

  ```bash
  DOCKER_BUILDKIT=1 docker build --secret id=npmrc,src=$HOME/.npmrc -t ais-its-safety-service .
  # behind a TLS-intercepting proxy, add the optional CA bundle secret (spec §11):
  DOCKER_BUILDKIT=1 docker build --network host --secret id=npmrc,src=$HOME/.npmrc \
    --secret id=ca,src=/path/to/ca-bundle.crt -t ais-its-safety-service .
  ```

- **Health**: `/health/live` (process), `/health/ready` (database, NATS; `503` while shutting
  down).
- **Metrics** (`/metrics`, prefix `aisits_`): kit HTTP and event metrics, detector metrics
  `aisits_detector_evaluations_total{detector}`, `aisits_detector_duration_seconds{detector}`,
  `aisits_detector_alerts_total{detector,severity}`, `aisits_detector_errors_total{detector,hook}`,
  `aisits_detector_skipped_total{detector,hook}`, `aisits_detector_positions_total{outcome}`, and the
  domain metrics of this service:

  | Metric                                                        | Meaning                                                                                                                        |
  | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
  | `aisits_safety_states_published_total{reason}`                | states published (`initial`, `change`, `heartbeat`)                                                                            |
  | `aisits_safety_state_publish_failures_total`                  | publications that failed (retried with the next report)                                                                        |
  | `aisits_safety_state_flush_duration_seconds`                  | duration of a batched state write and publication                                                                              |
  | `aisits_safety_state_flush_failures_total`                    | batched writes that failed (kept and retried with backoff)                                                                     |
  | `aisits_safety_states_pending`                                | vessel states waiting to be written                                                                                            |
  | `aisits_safety_encounter_samples_total{risk}`                 | encounter samples stored                                                                                                       |
  | `aisits_safety_encounter_sample_failures_total`               | encounter samples that could not be stored                                                                                     |
  | `aisits_safety_collision_pairs{risk}`                         | pairs tracked by the collision detector                                                                                        |
  | `aisits_safety_projection_rebuilds_total{projection,outcome}` | startup rebuilds of `zones` / `vessels`                                                                                        |
  | `aisits_safety_alert_resyncs_total{outcome}`                  | reloads of the open alerts when the instance starts consuming (`unchanged`; `changed` = another instance was active; `failed`) |

- **Troubleshooting**
  - _No EWS status other than 3_: only vessels with `predictedNavstatus = 1` are rated (legacy
    rule); check that an active `pipeline` zone with a line geometry exists
    (`GET /api/v2/safety/vessels/:mmsi` → `nearestPipelineZoneId`) and the ais-pipeline prediction.
  - _Positions not processed_: another instance holds the exclusive durable (a second replica
    stands by until the active one stops pulling for `DETECTOR_PINNED_TTL_MS`; the log says "Another
    instance is active: standing by"); check `aisits_detector_positions_total{outcome}` and the
    consumer `safety-positions[-<ids>]` (`nats consumer info AIS_POSITION safety-positions`).
  - _After a failover_: the new instance logs "Another instance was active: reloaded the open
    alerts …" and counts `aisits_safety_alert_resyncs_total{outcome="changed"}`; `failed` means the
    `events` table could not be read — the detector calls fail (logged, counted in
    `aisits_detector_errors_total`) and the next position retries.
  - _Slow feed_: `aisits_detector_duration_seconds{detector}` and `…_skipped_total`; give the slow
    detector its own deployment (`DETECTORS`) or raise `DETECTOR_CONCURRENCY`.
  - _States not published_: `aisits_safety_state_flush_failures_total` /
    `…_publish_failures_total` and the logs of `SafetyStateWriter`.
  - _Org users see no events_: the vessel must be in the `vessels` projection with their
    organization (`FLEET`); `aisits_safety_projection_rebuilds_total{outcome="failed"}` reports a
    failed startup rebuild.
  - _Startup stuck_: the runner waits up to `PROJECTION_CATCH_UP_TIMEOUT_MS` for the `GEO` / `FLEET`
    snapshots; missing streams are created empty (services boot in any order).
- Release: move the `Unreleased` entries of [CHANGELOG.md](CHANGELOG.md) under the new version,
  bump `package.json`, tag `v<version>`.

## Legacy parity notes

- **EWS** = legacy `checkShipStatus` (`be-legacy/src/utils/calculate-ews.ts`): `d = distance(p,
nearestPointOnLine(line, p))` in metres with Turf.js 7 (sphere R = 6 371 008.8 m) — reproduced by
  the SDK's `'sphere'` distance model (the default `'wgs84'` differs by up to ~13 m, enough to flip
  a status at a threshold); `predictedNavstatus = 1` and `d < 500` → `0`, `< 1 750` → `1`, else `3`
  (`2` unused, as in the legacy data). The legacy call passed the **predicted** navstatus
  (`ais.service.ts`), so a vessel reporting navstatus 1 but not predicted at anchor is safe.
- Intentional changes (spec §15.7): pipelines come from the active `pipeline` zones of the geo
  service (nearest one wins, `MultiLineString` supported) instead of `data/pipeline.json` read from
  disk on every call — the global zones for every vessel plus an organization's own zones for its
  vessels (spec §8.5; the legacy had a single public pipeline, so the parity is unchanged); the rule runs continuously server-side, persists events and raises alerts; a
  vessel without any pipeline zone is safe with `pipelineDistanceM = null`.
- An open EWS occurrence is re-evaluated with the vessel's next position only: a vessel that stops
  reporting while warned stays flagged (the conservative choice near a pipeline). Collision
  occurrences of pairs that stop reporting are resolved by the detector's 30 s tick once neither
  vessel was evaluated within `COLLISION_MAX_AGE_S`.
- **Collision** is new in v2 (spec §15.8): no legacy counterpart.
- The legacy frontend showed status `2` as "Normal"; v2 uses the backend codes `0 | 1 | 3`.

## Known limitations

- **Failover** relies on the local resync described under
  [Deployment](#deployment-one-active-instance-per-durable) until the kit reloads the alert state
  itself; run one replica per deployment.
- **EWS** compares each position with every active pipeline zone that applies to the vessel
  (`ZoneIndex.nearest` without `maxDistanceM`), so that `pipelineDistanceM` is known for every
  vessel as in the legacy rule — fine for tens of pipelines; a large network would need a distance
  cap (vessels beyond it would get `null`). An open EWS occurrence is re-checked with the vessel's
  next position only (see the parity notes).
- The EWS **status** of a vessel near an org-owned pipeline is shared with every tenant
  (navigational safety is shared, spec §8.5); only the zone and the distance are private.
- **Collision**: relative motion on a local plane (fine within the 6 nm search radius), AIS antenna
  positions rather than the hull centre, ship size and manoeuvrability ignored; every threshold is
  a v2 design default awaiting domain validation.
- `vessel_state` is a latest-state cache: positions are acknowledged before their state is
  written, so a crash loses at most one `SAFETY_STATE_FLUSH_MS` window, restored by the vessels'
  next positions; detector state (neighbours, encounters) is rebuilt from new positions after a
  restart, seeded by the open alerts.

## Methodology & references

Every formula, constant, threshold and rule is traceable (spec §17): the implementing functions
carry `@method <id>` TSDoc, the ids are listed in
[`src/modules/methodology/implemented-methods.ts`](src/modules/methodology/implemented-methods.ts)
(served by `GET /api/v2/safety/methodology`) and described in the catalog
(`docs/references/methods.json`, shipped as `@darmawanweb/ais-its-contracts/references`).

| Method id                                                                                | What                                                                                                        | Implemented by                                                                                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [`ews.pipeline_distance_status`](../../docs/METHODOLOGY.md#ews.pipeline_distance_status) | pipeline EWS status from the distance to the nearest pipeline line (500 m / 1 750 m, anchored vessels only) | `src/domain/ews.ts#assessEws` (+ `#pipelineAppliesTo`: which zones apply, spec §8.5), `src/detectors/ews/ews.detector.ts` |
| [`collision.cpa_tcpa`](../../docs/METHODOLOGY.md#collision.cpa_tcpa)                     | CPA/TCPA from relative motion, risk bands, hysteresis, exclusions                                           | `src/domain/cpa.ts#computeCpaTcpa`, `src/domain/collision-risk.ts`, `src/detectors/collision/`                            |

Inputs computed elsewhere: [`navstatus.prediction`](../../docs/METHODOLOGY.md#navstatus.prediction)
(`predictedNavstatus`, ais-pipeline) and [`navstatus.ais_codes`](../../docs/METHODOLOGY.md#navstatus.ais_codes)
(navstatus 1 / 5 / 6 and the "not available" SOG 102.3 / COG 360 used by the exclusions).

Sources:

- EWS thresholds — PP 27/2021 Pasal 31(3) (500 m prohibited + 1 250 m restricted zone,
  <https://peraturan.bpk.go.id/Details/161858/pp-no-27-tahun-2021>); Permen ESDM 32/2021 (no
  anchoring in the restricted area, <https://peraturan.bpk.go.id/Details/215446/permen-esdm-no-32-tahun-2021>);
  Ditjen Migas on 1 750 m around pipelines
  (<https://migas.esdm.go.id/post/tumpahan-minyak-pipa-penyalur-minyak-pertamina-sesuai-standar>);
  distance semantics Turf.js 7.2 (<https://github.com/Turfjs/turf>). The "anchored vessels only" rule
  and the article the thesis relied on still **need a citation** (`// SOURCE: thesis — needs citation`).
- CPA/TCPA — Lenart (2015), _Analysis of Collision Threat Parameters and Criteria_
  (<https://doi.org/10.1017/S0373463315000223>); IMO MSC.192(79) radar performance standards
  (<https://wwwcdn.imo.org/localresources/en/KnowledgeCentre/IndexofIMOResolutions/MSCResolutions/MSC.192(79).pdf>);
  COLREG 1972 Rules 7–8 (<https://www.imo.org/en/About/Conventions/Pages/COLREG.aspx>); Bole, Wall &
  Norris (2014), _Radar and ARPA Manual_; Wawruch (2018) on AIS CPA accuracy
  (<https://doi.org/10.12716/1001.12.03.02>); 1 nm = 1 arc-minute (Williams, _Aviation Formulary_).
- The collision thresholds (6 nm, 2 min, 0.5 kn, the three bands, 20 % hysteresis) are **v2 design
  defaults** of the platform spec §13.7 that need domain validation (catalog `needsCitation`), marked
  in the code with `// SOURCE: thesis — needs citation (v2 design default)`.

## Contributing

Conventional commits (commitlint), lint-staged on commit (Husky). CI runs format, lint, typecheck,
unit and integration tests, build, the `openapi.json` freshness check and the image build.
