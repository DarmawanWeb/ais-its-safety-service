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
  (open → resolved), at most one open row per `dedup_key`. The end of an occurrence is published
  as `alert.resolved.v1` (after the alert cooldown since its last raise), so the notification
  inbox closes the alert. The open rows are restored at startup and reloaded by the kit whenever
  an instance becomes the active one, so neither a restart nor a failover raises an open alert
  again or misses one resolved elsewhere.
- **REST API** `/api/v2/safety/*` for the live map (initial safety states, active encounters with
  their predicted CPA points), the safety pages of the web app (events, encounters, with vessel
  identities and localizable texts), dashboards (counts of the vessels at risk) and traceability
  (detectors, methodology).

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
    RUN["DetectorRunner<br/>(durable safety-positions, exclusive;<br/>activation reloads open alerts)"]
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
  AISP --> RUN --> EWS & COL
  EV -- open rows (boot, activation) --> RUN
  RUN -- replaceOpen --> EMIT
  GEO -- ordered, last per subject --> IDX
  FLEET -- ordered, last per subject --> IDX
  IDX --> EWS & COL
  EWS & COL -- raise / resolve --> EMIT
  EMIT -- persist first (1 open row per key, last_seen_at) --> EV
  EMIT -- alert.raised.v1 / alert.resolved.v1 --> ALERTS
  EWS & COL -- state parts --> WRITER
  WRITER --> VS
  WRITER -- safety.vessel_state.updated.v1 --> SAFETY
  COL -- samples --> EN
  GEO & FLEET --> PROJ --> PZ
  API --> VS & EV & EN & PZ
```

Startup follows the kit's lifecycle rule: connect, migrate (from this package's `migrations/`,
`MIGRATIONS_DIR`) and ensure the produced streams (`SAFETY`, `ALERTS`) in `onModuleInit` → restore
open alerts, load the `GEO` / `FLEET` snapshots, rebuild the `zones` / `vessels` tables, start the
durable consumers and the ticks in `onApplicationBootstrap` → the port opens. The instance is
inactive until the server pins its position consumer; its first position after the pin activates
it (see [Deployment](#deployment-replicas-and-failover)). On `SIGTERM` readiness turns `503`, the
position consumer stops and releases its pin (a standby takes over at once), pending resolutions
are published, consumers drain, the state writer flushes, NATS drains and the pool closes.

| Path                                          | What                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/detectors/ews/`                          | `EwsDetector`, `EWS_*` config, golden parity tests with the legacy `checkShipStatus`            |
| `src/detectors/collision/`                    | `CollisionDetector`, `COLLISION_*` config, `EncounterTracker` (bands, encounter ids)            |
| `src/detectors/detectors.module.ts`           | Detector SDK wiring (`DetectorRunnerModule`, `'sphere'` distances, pair search grid)            |
| `src/detectors/detector-events.repository.ts` | `AlertPersistence` hook: the `events` table (one open row per key, event-time `last_seen_at`)   |
| `src/detectors/alert-text.ts`                 | localizable texts: the `messageKey` constants and their `messageParams`                         |
| `src/domain/`                                 | pure functions with `@method` TSDoc: `ews.ts`, `cpa.ts`, `collision-risk.ts`, `safety-state.ts` |
| `src/modules/vessel-states/`                  | `SafetyStateWriter` (producer of `SAFETY`), `GET /safety/vessels[/:mmsi]`, `GET /safety/stats`  |
| `src/modules/events/`                         | `GET /safety/events[/:id]`                                                                      |
| `src/modules/encounters/`                     | encounter recorder (detector sink) and `GET /safety/encounters`                                 |
| `src/modules/methodology/`                    | `GET /safety/methodology` from the contracts catalog                                            |
| `src/consumers/`                              | durable `GEO` / `FLEET` projections into `zones` / `vessels`, startup rebuild                   |
| `src/common/`                                 | tenancy scope (spec §8.5), domain metrics, vessel identities of events and encounters           |
| `migrations/`                                 | forward-only SQL migrations                                                                     |
| `test/`                                       | integration tests against TimescaleDB/PostGIS and NATS containers                               |

### How a position flows

1. The runner receives `ais.position.recorded.v1` on the durable `safety-positions` (one active
   instance, `exclusive`), updates `VesselStateStore` and `PairSearch` (older or duplicate positions
   are dropped) and calls every enabled detector (`DETECTOR_CONCURRENCY` vessels in parallel, one
   vessel's positions in order). The first position after the instance was pinned activates it
   first: the open alerts are reloaded from `events` and the detectors drop local state
   (`onActivated`, see [Deployment](#deployment-replicas-and-failover)).
2. `ews` measures the distance to the nearest active `pipeline` zone line that applies to the
   vessel — global zones and its organization's own (Turf.js semantics, metres) — and classifies it; `collision` queries the neighbours within `COLLISION_SEARCH_RADIUS_NM`
   seen within `COLLISION_MAX_AGE_S`, aligns the candidate to the position's time (dead reckoning),
   computes CPA/TCPA and the band with hysteresis.
3. Each detector raises or resolves its alerts through the `AlertEmitter` (one state machine per
   `dedupKey`: raised → escalated → de-escalated / unchanged / suppressed → resolved) — the hook
   writes `events` **before** `alert.raised.v1` / `alert.resolved.v1` is published; repeats of an
   unchanged severity move `last_seen_at` at most every 60 s of event time — and reports its part
   of the vessel's safety state to the `SafetyStateWriter`. A resolution is announced once the key's
   `ALERT_COOLDOWN_S` since its last raise is over (the runner's 30 s housekeeping); a re-raise
   within it reopens the occurrence and cancels the announcement.
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
open row of the key (`'superseded'`), so a key never has two open rows (the kit serializes a key
within one instance and reloads the open rows on every activation; the database invariant covers an
instance that lost its pin while finishing a position). `time`, `opened_at`, `last_seen_at` and
`resolved_at` are event (AIS) time: `last_seen_at` follows the repeats of an unchanged condition
(the kit's `onRepeated`, at most every 60 s of event time), de-escalations and reopenings, never
moves back and is not moved by the resolution. `data` and `resolution` carry the localizable text
(`messageKey`, `messageParams`, [below](#localizable-texts)) of the alert and of its end.
The partial index `vessel_state_at_risk_idx` (`0001`, states with an EWS status other than safe
or a collision band above `none`) serves `GET /safety/stats`: the counts read the few vessels at
risk, not every state. `nearest_pipeline_org_id` (migration `0002`) records the owner of an
org-owned pipeline zone: the REST API shows that zone and its distance to the owner and to
authorities only, and the shared `SAFETY` stream never carries them. Migration `0003` indexes
`vessel_state.collision_evaluated_at` (partial, non-null): its maximum is the collision detector's
event clock, against which `GET /safety/encounters?active` measures its window. Encounters group
samples by `encounter_id` from the first band above `none` to the return to `none`; an unchanged
band is sampled at most every `COLLISION_SAMPLE_INTERVAL_S`.

## API

Routes live under `/api/v2` (OpenAPI: `/docs`, `/openapi.json`, committed as
[`openapi.json`](openapi.json)); errors are RFC 9457 problem details (`application/problem+json`,
stable `code`). Every route requires a signed-in user (global default-deny guard).

| Method | Path                            | Permission                         | What                                                                                                                                                                                                                                                                                                                        |
| ------ | ------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v2/safety/vessels`        | `safety:read`                      | latest safety states `?bbox&ewsStatus=0,1&collisionRisk=medium,high&since&limit` (array, by MMSI; default: positions of the last 24 h, ≤ 5 000), with `vessel` `{ id, name, typeCode }` and `nearestPipeline` `{ id, code, name }`                                                                                          |
| GET    | `/api/v2/safety/vessels/:mmsi`  | `safety:read`                      | one vessel's state; `404 SAFETY_STATE_NOT_FOUND`; `400 VALIDATION_FAILED` (`field: 'mmsi'`) unless 9 digits                                                                                                                                                                                                                 |
| GET    | `/api/v2/safety/stats`          | `safety:read`                      | vessels at risk `?bbox&since` → `{ ews: { danger, warning, methodId }, collision: { high, medium, methodId }, since, at }`: the states `GET /safety/vessels` lists for the same window (default 24 h), counted in the database without its `limit` (**Stats** below)                                                        |
| GET    | `/api/v2/safety/events`         | `safety:read`                      | detector events `?detector&severity&status&mmsi&from&to&bbox&cursor&limit`, newest first (default 7 days, ≤ 366 days; `status=open` without `from`: every open occurrence), cursor page; `vessel` / `relatedVessel` identities, texts in `data` / `resolution`                                                              |
| GET    | `/api/v2/safety/events/:id`     | `safety:read`                      | one event; `404 SAFETY_EVENT_NOT_FOUND` (also outside the tenancy); `400 VALIDATION_FAILED` (`field: 'id'`) for a malformed UUID                                                                                                                                                                                            |
| GET    | `/api/v2/safety/encounters`     | `safety:read`                      | collision encounters with CPA/TCPA history `?from&to&risk&mmsi&encounterId&active&bbox&cursor&limit` (newest encounter first, default 24 h, ≤ 31 days; `risk` = peak band; the cursor keeps the first page's window and `active` cut-off); `vesselA` / `vesselB`, `messageKey` / `messageParams`, per sample `cpaPositions` |
| GET    | `/api/v2/safety/detectors`      | `safety:read`                      | detectors of this instance: enabled, method ids, active thresholds                                                                                                                                                                                                                                                          |
| GET    | `/api/v2/safety/methodology`    | any signed-in user                 | methods implemented here with their catalog entries and references                                                                                                                                                                                                                                                          |
| GET    | `/health/live`, `/health/ready` | public                             | liveness; readiness (database, NATS)                                                                                                                                                                                                                                                                                        |
| GET    | `/metrics`                      | public (not routed by the gateway) | Prometheus metrics                                                                                                                                                                                                                                                                                                          |

Tenancy (spec §8.5): safety **states** are shared across tenants, except the nearest pipeline when
it is an org-owned zone: `nearestPipelineZoneId`, `nearestPipeline` and `pipelineDistanceM` are
`null` for readers outside that organization (authority and super_admin see them; the EWS status
stays shared). The counts of `GET /safety/stats` are therefore the same for every reader, a
vessel warned by another organization's pipeline included. **Vessel identities** (`vessel`,
`relatedVessel`, `vesselA`, `vesselB`: `{ id, name, typeCode }` of the `vessels` projection,
`null` for an unregistered MMSI) are shared across tenants like the vessel registry, so the reader
of a collision event sees both vessels.
Org-owned pipeline zones only apply to their organization's vessels, so their alerts reach that
organization alone; alert data carries no owner organizations. **Events and encounters** are
visible to `authority` and `super_admin` in full; other roles see only those whose `mmsi` or
`relatedMmsi` (encounters: either vessel) belongs to a vessel of their active organization, from the
`vessels` projection of `FLEET` — the organization comes from the token, never from the request. A
principal without an organization sees none.

**Stats.** `GET /safety/stats` counts, among the vessels with a position at or after `since`
(default 24 h before the request) in `bbox` (optional) — exactly the window of
`GET /safety/vessels`, whose validation it shares — the vessels whose latest EWS status is danger
(`0`) or warning (`1`) and those whose latest collision risk is `high` or `medium` (the bands that
raise alerts; `low` and `none` are not counted). A vessel counts in both groups when both apply.
One statement over the partial index `vessel_state_at_risk_idx` (no `limit`: the list's 10 000 cap
does not apply). The response echoes the `since` applied, `at` is when the counts were taken, and
each group names its method (`ews.pipeline_distance_status`, `collision.cpa_tcpa`). The counts
follow the stored states. A vessel that stops reporting keeps its last EWS status until `since`
passes it (see the parity notes). Its collision band falls back to `none` when the active
collision detector ends the pair: on an evaluation without risk, or at its next 30 s tick once
the pair was not evaluated for `COLLISION_MAX_AGE_S` of event time. A pair the previous active
instance followed before a takeover or restart and that never reports again is not followed by
the new one: its band falls back when the new active instance resolves the pair's restored alert
(`COLLISION_MAX_AGE_S` of event time after its own first position at the earliest), resetting the
stored band of each vessel of the pair it follows no other pair of (a newer evaluation wins; the
change is published on `SAFETY` like any other). `since` must be an ISO-8601
date-time that JavaScript's `Date` reads, on both routes: week and ordinal dates, the basic
format, hour-only or colon-less times, comma fractions and signed years are refused like any
malformed value (`400 VALIDATION_FAILED`, `code: 'isIso8601'`). Status filters and `limit` are
refused (`400 VALIDATION_FAILED`).

**Encounter filters and fields.** `active=true` keeps the encounters still in progress, judged per
pair: the newest encounter of a pair is active while its latest sample has a band above `none` and
is at most `COLLISION_MAX_AGE_S` + `COLLISION_SAMPLE_INTERVAL_S` + 30 s (180 s with the defaults)
older than the collision detector's **event clock** — the AIS time of its newest evaluation
(`max(vessel_state.collision_evaluated_at)`, written by whichever instance or deployment runs the
detector), never later than the request time. Samples carry AIS time, which lags the wall clock
(the legacy `utc` mode of ais-pipeline dates a position up to about a minute before its reception;
pipeline latency and a backlog after an outage add to that), and the detector ages its pairs on the
same clock: it stores an unchanged band at least every sample interval while the pair is evaluated,
writes a `none` sample when the band falls back, and closes a pair not evaluated for
`COLLISION_MAX_AGE_S` of event time at its next 30 s tick, so on that clock no tracked pair's latest
sample is older than the window. A takeover or restart starts every followed pair over with a new
`encounterId` (the tracker lives in memory) and leaves the previous encounter without a closing
sample: it counts as ended as soon as its pair has a newer encounter, so a pair never has two active
encounters. A pair closed without a measurement (a vessel excluded or out of range) stays active
until the window passed; while no position arrives at all, the clock stands still, like the
detector's own. `active=false` keeps the ended encounters. `bbox` keeps the
encounters with a sample in the range where either vessel's report lies in the box; the
aggregates (`peakRisk`, `minCpaNm`, …) and `history` stay those of the whole range.
`history[].cpaPositions` = `{ a: { lat, lon }, b: { lat, lon } }` are the predicted positions at
the closest point of approach (each report dead-reckoned on constant SOG/COG to the sample time +
`tcpaMin`, method `collision.cpa_tcpa`), `null` without relative motion or for a closest point in
the past.

## Events

| Direction | Stream / subject                          | Event type                                            | Consumer / notes                                                                                                                                                       |
| --------- | ----------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| consumes  | `AIS_POSITION` / `ais.position.v1.>`      | `ais.position.recorded.v1`                            | durable **`safety-positions`** (a `DETECTORS` subset: `safety-positions-<sorted ids>`), exclusive, detector feed                                                       |
| consumes  | `GEO` / `geo.zone.v1.>`                   | `geo.zone.upserted.v1`, `geo.zone.deleted.v1`         | durable **`safety-zones`** → `zones` table; ordered `safety-geo-projection` → `ZoneIndex`; ordered `safety-zones-rebuild` at startup                                   |
| consumes  | `FLEET` / `fleet.vessel.v1.>`             | `fleet.vessel.upserted.v1`, `fleet.vessel.deleted.v1` | durable **`safety-fleet`** → `vessels` table; ordered `safety-fleet-projection` → `FleetDirectory`; ordered `safety-vessels-rebuild` at startup                        |
| produces  | `SAFETY` / `safety.state.v1.<mmsi>`       | `safety.vessel_state.updated.v1`                      | on a material change and as a heartbeat (`SAFETY_STATE_HEARTBEAT_S`); consumed by notification (`notification-safety`)                                                 |
| produces  | `ALERTS` / `alert.v1.ews.<mmsi>`          | `alert.raised.v1` (`type: ews`)                       | on the transition to warning / danger and on escalation; `dedupKey = ews:<mmsi>:<zoneId>`; consumed by `notification-alerts`                                           |
| produces  | `ALERTS` / `alert.v1.collision.<minMmsi>` | `alert.raised.v1` (`type: collision`)                 | on `medium` (warning) / `high` (critical) and on escalation; `dedupKey = collision:<minMmsi>:<maxMmsi>`, `relatedMmsi` = the other vessel                              |
| produces  | `ALERTS` / the raise's subject            | `alert.resolved.v1`                                   | the end of an occurrence, once `ALERT_COOLDOWN_S` since its last raise passed (none when it is raised again within it); `notification-alerts` resolves the inbox alert |
| produces  | `DLQ` / `dlq.<stream>.<consumer>`         | copy of a failed message                              | after `max_deliver` (10) failed deliveries of a durable consumer (kit)                                                                                                 |

Invalid messages are terminated and counted (`aisits_events_invalid_total`); all handlers are
idempotent (projections: newest snapshot wins; detectors: positions not newer than the vessel's
state are dropped, alerts are state machines per `dedupKey`; event rows insert on conflict do
nothing).

**Resolutions** (`alert.resolved.v1`, kit `publishResolutions`, default on): `safety.events`
remains the record (`status`, `resolved_at`, `resolution`; the REST API is unchanged), and the kit
announces the end on the raise's subject `alert.v1.<type>.<mmsi>` (same stream and per-subject
order as the raise; envelope id = `Nats-Msg-Id` = event id): at once when the key's last raise is
older than `ALERT_COOLDOWN_S`, otherwise when that window ends (the runner's 30 s housekeeping), on
deactivation or on a graceful stop. A re-raise within the window reopens the same occurrence
(`suppressed`, or escalated) and cancels the announcement, so flapping adds no notifications and the
inbox never shows resolved what a detector holds open. The consumer contract (notification):
resolve the unresolved inbox alert with this `dedupKey` unless it merged an occurrence later than
`resolvedAt`, do nothing when there is none, be idempotent by event id. A crash inside the cooldown
window loses that announcement (the resolution itself is stored). **Roll out after notification**
0.4 / kit 0.3: an older notification acknowledges and skips `alert.resolved.v1`.

Payload examples (`data` of the envelope):

```jsonc
// safety.vessel_state.updated.v1 (shared: an org-owned nearest pipeline is published as null / null)
{ "mmsi": 525005223, "time": "2026-11-21T10:00:10.000Z", "ewsStatus": 1, "pipelineDistanceM": 1000.2,
  "nearestPipelineZoneId": "0193…", "collisionRisk": "none", "closestEncounter": null,
  "methodIds": ["ews.pipeline_distance_status", "collision.cpa_tcpa"] }
// alert.raised.v1 (ews)
{ "type": "ews", "domain": "safety", "severity": "warning", "mmsi": 525005223, "zoneId": "0193…",
  "dedupKey": "ews:525005223:0193…", "methodId": "ews.pipeline_distance_status",
  "title": "Pipeline warning: KM Jangkar (MMSI 525005223)",
  "message": "KM Jangkar (MMSI 525005223) is predicted at anchor 1000 m from pipeline PL West (warning below 1750 m)",
  "data": { "methodId": "ews.pipeline_distance_status", "ewsStatus": 1, "pipelineDistanceM": 1000.2,
            "zoneId": "0193…", "thresholds": { "dangerM": 500, "warningM": 1750 }, …,
            "messageKey": "safety.ews.anchored_near_pipeline",
            "messageParams": { "vessel": "KM Jangkar (MMSI 525005223)", "mmsi": 525005223, "status": "warning",
                               "distanceM": 1000, "thresholdM": 1750, "zoneCode": "PL-W", "zoneName": "PL West" } } }
// alert.raised.v1 (collision)
{ "type": "collision", "severity": "critical", "mmsi": 525005223, "relatedMmsi": 525005224,
  "dedupKey": "collision:525005223:525005224", "methodId": "collision.cpa_tcpa",
  "data": { "risk": "high", "cpaNm": 0.08, "tcpaMin": 2.1, "rangeNm": 0.7, "encounterId": "0193…",
            "thresholds": { "high": { "cpaNm": 0.25, "tcpaMin": 6 }, …, "hysteresis": 0.2 }, …,
            "messageKey": "safety.collision.risk",
            "messageParams": { "risk": "high", "cpaM": 148, "cpaNm": 0.08, "rangeM": 1296, "rangeNm": 0.7, … } } }
// alert.resolved.v1 (on the raise's subject alert.v1.ews.525005223)
{ "id": "0193…", "alertId": "0193… (the last alert.raised.v1 of the occurrence)", "type": "ews",
  "domain": "safety", "severity": "warning", "mmsi": 525005223, "relatedMmsi": null, "zoneId": "0193…",
  "dedupKey": "ews:525005223:0193…", "openedAt": "2026-11-21T10:00:10.000Z",
  "resolvedAt": "2026-11-21T10:42:00.000Z", "reason": "safe: not at anchor within the warning distance",
  "methodId": "ews.pipeline_distance_status",
  "data": { "ewsStatus": 3, "pipelineDistanceM": 1900.4, "nearestPipelineZoneId": "0193…",
            "predictedNavstatus": 0, "messageKey": "safety.ews.resolved_safe", "messageParams": {} } }
```

## Localizable texts

The web app renders Bahasa Indonesia and English. Every alert keeps its English `title` and
`message` (e-mail, webhooks and older clients use them) and carries a stable **`messageKey`** with
its **`messageParams`** in `data`; resolutions carry them in their data (`events.resolution` and
`alert.resolved.v1.data`), encounters at the top level of the REST item. Keys are
`<domain>.<detector>.<situation>` constants of `src/detectors/alert-text.ts` (never built from
input; a different sentence gets a new key); params are flat strings, numbers and booleans whose
names carry their unit (`…M` metres, `…Nm` nautical miles, `…Min` minutes, `…S` seconds), rounded
like the English text. Distances are given in whole metres (`…M`, the coordinator's cross-service
convention); collision distances also in nautical miles (`…Nm`, 2 decimals), the unit of their
English sentence and of the collision fields in `data`. Vessel labels are `<name> (MMSI <mmsi>)`, or `MMSI <mmsi>` for an
unregistered vessel. Events stored before 0.2.0 have no key (render `title` / `message`).

| Key                                       | Params                                                                                                                                                                    | English (alert: title / message)                                                                                                     | Where                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `safety.ews.anchored_near_pipeline`       | `vessel`, `mmsi`, `status` (`warning` \| `danger`), `distanceM`, `thresholdM`, `zoneCode`, `zoneName`                                                                     | Pipeline {status}: {vessel} / {vessel} is predicted at anchor {distanceM} m from pipeline {zoneName} ({status} below {thresholdM} m) | `ews` alert                                             |
| `safety.ews.resolved_safe`                | —                                                                                                                                                                         | safe: not at anchor within the warning distance                                                                                      | `ews` resolution                                        |
| `safety.ews.resolved_other_pipeline`      | —                                                                                                                                                                         | another pipeline is nearer                                                                                                           | `ews` resolution                                        |
| `safety.ews.resolved_zone_deleted`        | —                                                                                                                                                                         | pipeline zone deleted                                                                                                                | `ews` resolution                                        |
| `safety.ews.resolved_zone_inactive`       | —                                                                                                                                                                         | zone is no longer an active pipeline                                                                                                 | `ews` resolution                                        |
| `safety.ews.resolved_zone_private`        | —                                                                                                                                                                         | pipeline zone is private to another organization                                                                                     | `ews` resolution                                        |
| `safety.collision.risk`                   | `vesselA`, `mmsiA`, `vesselB`, `mmsiB`, `risk` (`high` \| `medium`), `cpaM`, `rangeM` (whole metres), `cpaNm` (2 decimals), `tcpaMin` (1 decimal), `rangeNm` (2 decimals) | {risk} risk of collision: {vesselA} and {vesselB} / CPA {cpaNm} nm in {tcpaMin} min (range {rangeNm} nm)                             | `collision` alert                                       |
| `safety.collision.resolved_risk`          | `risk` (`low` \| `none`), `cpaM` (whole metres), `cpaNm`, `tcpaMin` (absent without relative motion: "n/a")                                                               | risk {risk} (CPA {cpaNm} nm, TCPA {tcpaMin} min)                                                                                     | `collision` resolution                                  |
| `safety.collision.resolved_pair_lost`     | —                                                                                                                                                                         | pair left the search radius, stopped reporting or was excluded                                                                       | `collision` resolution                                  |
| `safety.collision.resolved_excluded`      | `mmsi`, `exclusion` (`predicted_at_anchor` \| `stationary_navstatus` \| `sog_unavailable` \| `cog_unavailable` \| `slow`)                                                 | vessel {mmsi} excluded ({exclusion})                                                                                                 | `collision` resolution                                  |
| `safety.collision.resolved_no_risk`       | —                                                                                                                                                                         | no collision risk                                                                                                                    | `collision` resolution                                  |
| `safety.collision.resolved_stale`         | `maxAgeS`                                                                                                                                                                 | not evaluated for {maxAgeS} s                                                                                                        | `collision` resolution                                  |
| `safety.collision.resolved_not_evaluated` | —                                                                                                                                                                         | pair no longer evaluated                                                                                                             | `collision` resolution                                  |
| `safety.collision.encounter`              | `vesselA`, `mmsiA`, `vesselB`, `mmsiB`, `peakRisk` (`low` \| `medium` \| `high`), `minCpaM` (whole metres), `minCpaNm` (2 decimals)                                       | Encounter of {vesselA} and {vesselB}: {peakRisk} risk, closest CPA {minCpaNm} nm                                                     | `GET /safety/encounters` item                           |
| `safety.ews.escalated`                    | —                                                                                                                                                                         | escalated (superseded by the escalation's alert, `resolution.supersededBy`)                                                          | `events.resolution` of the event an escalation replaced |
| `safety.ews.superseded`                   | —                                                                                                                                                                         | superseded (another event of the key was opened, `resolution.supersededBy`)                                                          | `events.resolution`                                     |
| `safety.collision.escalated`              | —                                                                                                                                                                         | escalated (as for `ews`)                                                                                                             | `events.resolution`                                     |
| `safety.collision.superseded`             | —                                                                                                                                                                         | superseded (as for `ews`)                                                                                                            | `events.resolution`                                     |

## Configuration

Every variable is listed with its development default in [`.env.example`](.env.example); the
service refuses to start on invalid values (including invalid `EWS_*` / `COLLISION_*` values or an
unknown `DETECTORS` entry) and prints every problem.

| Variable                                                | Default                                                  | Notes                                                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                              | `development`                                            | `development` \| `test` \| `production`                                                                        |
| `SERVICE_NAME`                                          | `safety`                                                 | logs, metrics, event `source`, consumer names                                                                  |
| `SERVICE_VERSION`                                       | `package.json` version                                   |                                                                                                                |
| `HOST` / `PORT`                                         | `0.0.0.0` / `3011`                                       | spec §3                                                                                                        |
| `LOG_LEVEL` / `LOG_PRETTY`                              | `info` / `true` in development                           | pino JSON otherwise                                                                                            |
| `SHUTDOWN_TIMEOUT_MS`                                   | `30000`                                                  | graceful shutdown deadline                                                                                     |
| `DATABASE_URL`                                          | `postgres://safety_svc:safety_svc@localhost:5432/aisits` | role `safety_svc`                                                                                              |
| `DATABASE_SCHEMA`                                       | `safety`                                                 | `search_path=safety,public`                                                                                    |
| `DATABASE_POOL_MAX`                                     | `10`                                                     |                                                                                                                |
| `DATABASE_STATEMENT_TIMEOUT_MS`                         | `30000`                                                  |                                                                                                                |
| `DB_MIGRATE_ON_BOOT`                                    | `true`                                                   | also `pnpm migrate`                                                                                            |
| `NATS_URL`                                              | `nats://localhost:4222`                                  | comma separated list allowed                                                                                   |
| `NATS_DURABLE_PREFIX`                                   | empty                                                    | prefix of durable consumer names (tests)                                                                       |
| `AUTH_JWKS_URL`                                         | `http://localhost:3001/.well-known/jwks.json`            | access tokens are verified locally (cached JWKS)                                                               |
| `AUTH_ISSUER` / `AUTH_AUDIENCE`                         | `ais-its-auth` / `ais-its-api`                           |                                                                                                                |
| `AUTH_INTERNAL_URL`                                     | `http://localhost:3001`                                  | API-key introspection (no route of this service accepts API keys)                                              |
| `INTERNAL_TOKEN`                                        | `dev-internal-token-change-me`                           | ≥ 16 characters and changed in production                                                                      |
| `CORS_ORIGINS`                                          | `http://localhost:5173,http://localhost:8000`            |                                                                                                                |
| `TRUSTED_PROXIES`                                       | `loopback,linklocal,uniquelocal`                         | production: the gateway's address/CIDR only (a warning is logged at boot while the default is in effect)       |
| `PUBLIC_BASE_URL`                                       | `http://localhost:8000`                                  |                                                                                                                |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                           | unset                                                    | OTLP/HTTP tracing when set                                                                                     |
| `SAFETY_STATE_HEARTBEAT_S`                              | `300`                                                    | longest interval (event time) between two publications of an unchanged state (10–86 400)                       |
| `SAFETY_STATE_FLUSH_MS`                                 | `250`                                                    | batching interval of the state writer (20–10 000)                                                              |
| `DETECTOR_CONCURRENCY`                                  | `8`                                                      | vessels evaluated in parallel (1–64)                                                                           |
| `DETECTOR_PINNED_TTL_MS`                                | `30000`                                                  | pinned TTL of the exclusive position consumer (3 000–300 000): the failover time when the active instance dies |
| `ALERT_COOLDOWN_S`                                      | `600`                                                    | AlertEmitter cooldown: no re-publication of a key's severity within it; `alert.resolved.v1` waits for its end  |
| `PROJECTION_CATCH_UP_TIMEOUT_MS`                        | `60000`                                                  | how long startup waits for the `GEO` / `FLEET` snapshots                                                       |
| `DETECTORS`                                             | all (`ews,collision`)                                    | comma separated subset run by this instance                                                                    |
| `EWS_DANGER_M`                                          | `500`                                                    | danger distance, m (legacy)                                                                                    |
| `EWS_WARNING_M`                                         | `1750`                                                   | warning distance, m (legacy); must exceed `EWS_DANGER_M`                                                       |
| `COLLISION_SEARCH_RADIUS_NM`                            | `6`                                                      | candidate radius, nm (≤ 50)                                                                                    |
| `COLLISION_MAX_AGE_S`                                   | `120`                                                    | candidates seen within this window, s (≤ 600)                                                                  |
| `COLLISION_MIN_SOG_KN`                                  | `0.5`                                                    | slower vessels are excluded, kn                                                                                |
| `COLLISION_HIGH_CPA_NM` / `COLLISION_HIGH_TCPA_MIN`     | `0.25` / `6`                                             | band `high` (critical alert)                                                                                   |
| `COLLISION_MEDIUM_CPA_NM` / `COLLISION_MEDIUM_TCPA_MIN` | `0.5` / `12`                                             | band `medium` (warning alert)                                                                                  |
| `COLLISION_LOW_CPA_NM` / `COLLISION_LOW_TCPA_MIN`       | `1` / `20`                                               | band `low` (state only); limits must grow from high to low                                                     |
| `COLLISION_HYSTERESIS`                                  | `0.2`                                                    | a pair keeps its band until it leaves the limits widened by this fraction                                      |
| `COLLISION_SAMPLE_INTERVAL_S`                           | `30`                                                     | minimum interval between two stored samples of an unchanged encounter (0 = every evaluation)                   |

`REDIS_URL` is part of the platform base schema but not used: detector state lives in memory.

### Deployment: replicas and failover

Detector state (vessel states, neighbours, encounters, open alerts) lives in memory, so positions go
to **one active instance per durable** (`exclusive`, NATS priority group `pinned_client`, NATS ≥
2.11); further replicas of the same deployment are hot standbys (failover, not throughput). The
service is built to **run two or more replicas with rolling updates** (Kubernetes `RollingUpdate`
with `maxUnavailable: 0`, compose: start the new container before stopping the old one); no
`Recreate` strategy is needed:

- **Activation.** An instance starts inactive. When the server pins it, its first position first
  waits for running detector calls, publishes pending resolutions, **reloads the open occurrences**
  from `events` (`DetectorEventsRepository.loadOpen`, replace semantics: what the previous instance
  raised is taken over and not raised again, what it resolved is forgotten), then the detectors'
  `onActivated` runs (`collision` restarts its pair tracker seeded by the open alerts, the stored
  bands stay until it evaluates the pair or resolves its restored alert, see **Stats**; `ews` resolves
  the open occurrences whose pipeline zone was deleted, deactivated or became another
  organization's while no instance acted on it). Only then is the position dispatched.
- **Standby.** A standby still loads every `GEO` / `FLEET` change, but ticks (the collision
  housekeeping) and alert changes from zone or vessel changes run on the active instance only.
- **Graceful stop** (rollout): the position consumer releases its pin at once, pending resolutions
  are published, and a standby takes over with its next pull. A crashed or frozen active instance
  is replaced once it pulled nothing for `DETECTOR_PINNED_TTL_MS` (30 s; idle instances keep their
  pin, the kit pulls every third of it).
- The `events` table keeps one open row per `dedup_key` under a per-key advisory lock, which also
  covers an instance that lost its pin while it was still finishing a position.

**Platform chart: not updated yet.** `infra/helm/ais-its-platform` still deploys safety with
`replicaCount: 1` and `strategy: Recreate` (`values.yaml`, the one-consumer rule of kit 0.2; the
Helm README says the same). As shipped there is therefore no hot standby: a crashed Pod is replaced
by Kubernetes, not by a standby, and every rollout stops the old Pod before the new one boots
(positions wait in the durable meanwhile, nothing is lost; the new instance activates as described
above). The central follow-up is to give safety `replicaCount: 2` or more with `RollingUpdate`
(`maxUnavailable: 0`) and to update the Helm README; until it lands, the failover above applies to
deployments that run several replicas themselves.

**Rollout order** with kit 0.3 / contracts 0.4: deploy notification (which handles
`alert.resolved.v1`) first, then this service; resolutions published to an older notification are
acknowledged and skipped. While a rollout from 0.1.0 is in progress, a request that reaches a
0.1.0 replica answers `404` for `GET /safety/stats` (added in 0.2.0); clients retry on their next
refresh.

### Deployment: one deployment per detector

To spread the load, split the detectors over deployments with `DETECTORS`: each subset consumes through its
own durable, both write their part of `vessel_state` (the parts merge) and both serve the REST API.

```yaml
# docker compose (excerpt) — same image, two deployments
safety-ews:
  image: ghcr.io/darmawanweb/ais-its-safety-service:0.2.0
  environment:
    DETECTORS: ews # durable safety-positions-ews
    EWS_DANGER_M: '500'
    EWS_WARNING_M: '1750'
safety-collision:
  image: ghcr.io/darmawanweb/ais-its-safety-service:0.2.0
  environment:
    DETECTORS: collision # durable safety-positions-collision
    COLLISION_SEARCH_RADIUS_NM: '6'
    DETECTOR_CONCURRENCY: '16'
```

`GET /safety/detectors` of each deployment lists the detector it runs (`enabled: true`) and the
other one disabled. The gateway route `/api/v2/safety` can point at either deployment; give every
deployment the same `COLLISION_*` values, since `GET /safety/encounters?active=…` derives its
window from the instance's own `COLLISION_MAX_AGE_S` / `COLLISION_SAMPLE_INTERVAL_S`. Each
deployment runs its own replicas (one active per durable).

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
    (alerts, no repeats, escalation, de-escalation, resolution, ticks, configuration), the
    published `alert.resolved.v1` (one after the cooldown, none after a re-raise within it, at once
    for an older occurrence), activation and standby (`deactivate()` / `activate()`: zone and
    vessel changes left to the active instance and resolved on activation, the collision tracker
    starting over, housekeeping only while active, the window of restored alerts in event time, the
    stored bands of a restored pair falling back when its alert is resolved without the pair being
    followed),
    `onRepeated` throttling (`last_seen_at`) and the localizable texts of alerts and resolutions.
  - `src/detectors/alert-text.spec.ts` — key format, every key documented in this README, metre
    params; `src/modules/encounters/dto/encounter.dto.spec.ts` — vessel identities, encounter text,
    predicted CPA positions, the `active` window; `encounters.service.spec.ts` — the `active`
    cut-off on the collision detector's event clock (never ahead of the request time, kept by the
    cursor); `src/domain/cpa.spec.ts` also covers `predictedCpaPositions`.
  - `src/consumers/projection-rebuild.service.spec.ts` — a failed rebuild is logged without the
    bound values of the statement (`sanitizeError`).
  - `src/modules/vessel-states/safety-state.writer.spec.ts` — batching, heartbeat, retries,
    collision resets (written after each round's reports, never held back by a steady flow of
    them; merged with a pending report of the vessel: the newest part wins, the later call on a
    tie; retried after a failure);
    `vessel-states.service.spec.ts` — the stats window (default 24 h, the list's `bbox` / `since`),
    the response with its method ids and `since` values ISO-8601 allows but `Date` cannot read
    (refused by both queries); `src/common/tenancy.spec.ts` — scopes and the visibility of
    org-owned pipelines.
- **Integration tests** (`pnpm test:int`, Docker): the real `AppModule` against
  `timescale/timescaledb-ha:pg17` and `nats:2.11-alpine` started once by
  `test/support/global-setup.ts`, signed test JWTs:
  - `test/safety.int.test.ts` — zones (GEO) and positions (AIS_POSITION) published to NATS → safety
    states on `SAFETY`, `alert.raised.v1` for EWS warning and danger and for a crossing encounter,
    no repeats while unchanged, resolutions in `events`, encounter history, REST queries and tenancy,
    vessel identities, `nearestPipeline`, texts, `cpaPositions`, `active` and `bbox`.
  - `test/projections.int.test.ts` — projection rebuild from the compacted streams, tombstones,
    `DETECTORS` subset on its own durable.
  - `test/app.int.test.ts` — health, migrations, auth, OpenAPI, metrics.
  - `test/failover.int.test.ts` — two instances on one durable: A stops gracefully (releases the
    pin), B activates before its first position with A's open occurrences (forgets what A resolved,
    takes over what A raised), raises nothing twice (stream contents by event type) and announces
    its own resolution once with the `alert.resolved.v1` contract fields.
  - `test/encounters.int.test.ts` — `active` judged per pair and in event time (from an empty
    `AIS_POSITION` stream: a new durable replays it, and the global clocks must not see the
    positions of other files): positions 10 min behind the wall clock stay active until the
    detector's clock passes the window; across a takeover (A stops, B follows the pair with a new
    encounter) only the newest encounter of the pair is active, the previous one is listed as
    ended.
  - `test/resolutions.int.test.ts` — `ALERT_COOLDOWN_S=3` with the real runner: one
    `alert.resolved.v1` once the cooldown since the raise passed (not before), none when the
    condition returns within it (reopened, one open row).
  - `test/stats.int.test.ts` — `GET /safety/stats` over seeded states: the default 24 h window,
    `since`, `bbox`, the same counts as the filtered `GET /safety/vessels`, the same counts for the
    five roles with `safety:read` (also for a vessel warned by another organization's pipeline),
    validation (also `since` values ISO-8601 allows but `Date` cannot read, on both routes: `400`,
    never `500`) and permission, and the plan on 20 000 states (the partial index
    `vessel_state_at_risk_idx`, no sequential scan).
  - `test/takeover-states.int.test.ts` — a pair at high risk when A hands over to B, never
    reported again: B keeps the band while the pair may still report, then resolves the restored
    alert and both stored bands fall back to `none` (`vessel_state`, `GET /safety/stats`, the
    list, `SAFETY`); the guard of the reset statement (a newer stored part, a band already `none`,
    a vessel without a state).
  - `test/tenancy.int.test.ts` — an org-owned pipeline: no EWS for another organization's vessel;
    the owner's vessel is warned, the zone and distance are `null` on `SAFETY` and in REST for
    other tenants, the event is visible to the owner only, no owner organizations in alert data.
  - `test/events.int.test.ts` — one open row per key (supersede on raise and reopen, with texts),
    `onUpdated` / `onRepeated` never moving `last_seen_at` back, `loadOpen` with domain, method and
    event times, `last_seen_at` / `resolved_at` in event time, `status=open` beyond the 7-day
    default, encounter pages that never skip an encounter getting new samples, active / ended
    encounters and the cursor keeping the `active` cut-off.

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
  `aisits_detector_alerts_total{detector,severity}`, `aisits_detector_errors_total{detector,hook}`
  (hooks include `onActivated`), `aisits_detector_skipped_total{detector,hook}`,
  `aisits_detector_positions_total{outcome}`, `aisits_detector_alert_resolutions_total{detector}`,
  `aisits_detector_activations_total{outcome}` and `aisits_events_consumer_activations_total{consumer}`
  (takeovers), and the domain metrics of this service:

  | Metric                                                        | Meaning                                                    |
  | ------------------------------------------------------------- | ---------------------------------------------------------- |
  | `aisits_safety_states_published_total{reason}`                | states published (`initial`, `change`, `heartbeat`)        |
  | `aisits_safety_state_publish_failures_total`                  | publications that failed (retried with the next report)    |
  | `aisits_safety_state_flush_duration_seconds`                  | duration of a batched state write and publication          |
  | `aisits_safety_state_flush_failures_total`                    | batched writes that failed (kept and retried with backoff) |
  | `aisits_safety_states_pending`                                | vessel states waiting to be written                        |
  | `aisits_safety_encounter_samples_total{risk}`                 | encounter samples stored                                   |
  | `aisits_safety_encounter_sample_failures_total`               | encounter samples that could not be stored                 |
  | `aisits_safety_collision_pairs{risk}`                         | pairs tracked by the collision detector                    |
  | `aisits_safety_projection_rebuilds_total{projection,outcome}` | startup rebuilds of `zones` / `vessels`                    |

- **Troubleshooting**
  - _No EWS status other than 3_: only vessels with `predictedNavstatus = 1` are rated (legacy
    rule); check that an active `pipeline` zone with a line geometry exists
    (`GET /api/v2/safety/vessels/:mmsi` → `nearestPipelineZoneId`) and the ais-pipeline prediction.
  - _Positions not processed_: another instance holds the exclusive durable (a standby takes
    over when the active one stops, at once on a graceful stop, after `DETECTOR_PINNED_TTL_MS`
    otherwise); check `aisits_detector_positions_total{outcome}`, the readiness of each replica
    and the consumer `safety-positions[-<ids>]` (`nats consumer info AIS_POSITION safety-positions`:
    priority group `pinned_client`). NATS must be 2.11 or later.
  - _After a failover_: the new active instance counts
    `aisits_detector_activations_total{outcome="completed"}`; `failed` means its activation (for
    example reading the open rows of `events`) failed — the position is redelivered with backoff
    and the activation retried.
  - _Inbox alerts stay open_: resolutions are announced after `ALERT_COOLDOWN_S` since the last
    raise (`aisits_detector_alert_resolutions_total`); notification must run contracts 0.4 (older
    instances skip `alert.resolved.v1`).
  - _Startup warnings_: NATS `max_payload` below 4 MiB (set `max_payload: 4MB` on the server) and,
    in production, the default `TRUSTED_PROXIES`.
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

- **Resolution announcements** wait for the end of `ALERT_COOLDOWN_S` since the last raise and
  live in memory until then: a crash inside that window loses the `alert.resolved.v1` (the
  resolution itself is stored in `events`), and the inbox alert then stays open until it is
  resolved by hand or the condition is raised and ended again.
- **Active encounters** are inferred from the stored samples, per pair and on the collision
  detector's event clock: an encounter closed without a measurement (a vessel excluded or out of the
  search radius) still counts as active until its window (180 s by default) passed on that clock,
  and the window follows this instance's `COLLISION_*` values. A pair followed across a takeover or
  restart gets a new `encounterId`; the previous encounter has no closing `none` sample and ends
  with the new one (`active=false`), so the web sees the pair's line continue under a new id. A
  report with a future time stamp can hold the clock ahead of the wall clock; the cut-off then falls
  back to the request time until real time passes it.
- **Texts**: events stored before 0.2.0 carry no `messageKey` (clients fall back to `title` /
  `message`). Collision fields (`data.cpaNm` / `rangeNm`, encounter samples) stay in nautical miles;
  their texts carry whole metres (`cpaM`, `rangeM`, `minCpaM`) next to the nautical miles of the
  English sentence (`cpaNm`, `rangeNm`, `minCpaNm`).
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
  restart or a takeover, seeded by the open alerts (a pair followed across a takeover gets a new
  `encounterId`, and the previous encounter counts as ended; the stored bands of a pair that never
  reports again fall back when the new active instance resolves its restored alert — a `low` pair
  raises no alert, so its band, which `GET /safety/stats` does not count, stays until the vessel
  reports again). A band whose own fall-back was lost that way (a crash within one flush interval
  after its pair was closed) has no open alert left to end: it stays — and counts in
  `GET /safety/stats` — until the vessel reports again or its last position leaves `since` (24 h by
  default). So do the bands left by 0.1.0 takeovers, which never reset them.

## Methodology & references

Every formula, constant, threshold and rule is traceable (spec §17): the implementing functions
carry `@method <id>` TSDoc, the ids are listed in
[`src/modules/methodology/implemented-methods.ts`](src/modules/methodology/implemented-methods.ts)
(served by `GET /api/v2/safety/methodology`) and described in the catalog
(`docs/references/methods.json`, shipped as `@darmawanweb/ais-its-contracts/references`).

| Method id                                                                                | What                                                                                                        | Implemented by                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`ews.pipeline_distance_status`](../../docs/METHODOLOGY.md#ews.pipeline_distance_status) | pipeline EWS status from the distance to the nearest pipeline line (500 m / 1 750 m, anchored vessels only) | `src/domain/ews.ts#assessEws` (+ `#pipelineAppliesTo`: which zones apply, spec §8.5), `src/detectors/ews/ews.detector.ts`                  |
| [`collision.cpa_tcpa`](../../docs/METHODOLOGY.md#collision.cpa_tcpa)                     | CPA/TCPA from relative motion, risk bands, hysteresis, exclusions, predicted CPA positions                  | `src/domain/cpa.ts#computeCpaTcpa` (+ `#deadReckon`, `#predictedCpaPositions`), `src/domain/collision-risk.ts`, `src/detectors/collision/` |

Both methods are `implemented` in the central catalog (contracts 0.4.0). Inputs computed
elsewhere: [`navstatus.prediction`](../../docs/METHODOLOGY.md#navstatus.prediction)
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
