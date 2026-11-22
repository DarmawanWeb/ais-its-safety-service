import {
  type AlertSeverity,
  type CollisionRisk,
  collisionRiskAlertSeverity,
  collisionRiskLabel,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  type Detector,
  type DetectorContext,
  RegisterDetector,
  type VesselPosition,
  type VesselState,
} from '@darmawanweb/ais-its-nest/analytics';
import { Inject, Injectable } from '@nestjs/common';

import { SafetyMetrics } from '../../common/safety.metrics.js';
import type { EncounterVesselPosition } from '../../db/schema.js';
import {
  assessCollisionRisk,
  collisionDedupKey,
  collisionExclusion,
} from '../../domain/collision-risk.js';
import { computeCpaTcpa, deadReckon, METERS_PER_NM } from '../../domain/cpa.js';
import { COLLISION_METHOD_ID } from '../../domain/safety-state.js';
import {
  ENCOUNTER_SINK,
  type EncounterSample,
  type EncounterSink,
} from '../../modules/encounters/encounter.js';
import {
  SAFETY_STATE_SINK,
  type SafetyStateSink,
} from '../../modules/vessel-states/safety-state.sink.js';
import {
  type LocalizableText,
  localizable,
  MESSAGE_KEYS,
  metresOfNm,
  rounded,
} from '../alert-text.js';
import { COLLISION_ALERT_TYPE } from '../alert-types.js';
import { kinematicsOf, vesselLabel } from '../vessel-kinematics.js';
import {
  collisionBands,
  type CollisionConfig,
  collisionConfigSchema,
} from './collision.config.js';
import {
  type EncounterTransition,
  EncounterTracker,
  type PairMeasurement,
  sameCollisionCategory,
  type TrackedEncounter,
  type VesselCollisionSummary,
} from './encounter-tracker.js';

/** `value` with `digits` decimals for alert texts, without a negative zero ("-0.0"). */
function fixed(value: number, digits: number): string {
  const factor = 10 ** digits;
  return (Math.round(value * factor) / factor || 0).toFixed(digits);
}

/** How a pair's occurrence ends when it is closed without a new measurement. */
interface PairEnd {
  readonly reason: string;
  readonly text: LocalizableText;
}

/** Interval of the housekeeping tick (stale pairs, orphaned alerts), ms. */
export const COLLISION_TICK_MS = 30_000;

type Report = VesselPosition | VesselState;

function reportOf(state: Report): EncounterVesselPosition {
  return {
    mmsi: state.mmsi,
    time: state.time.toISOString(),
    lat: state.lat,
    lon: state.lon,
    sog: state.sog,
    cog: state.cog,
  };
}

/**
 * CPA/TCPA of a vessel and a candidate. The candidate's latest report is
 * first propagated to the time of the vessel's position (dead reckoning,
 * constant SOG/COG), so both are compared at one instant.
 *
 * @method collision.cpa_tcpa
 * @see docs/METHODOLOGY.md §6.1 (`collision.cpa_tcpa`)
 */
export function measurePair(
  own: VesselPosition,
  other: VesselState,
): Omit<PairMeasurement, 'at'> {
  const aligned = deadReckon(
    { lat: other.lat, lon: other.lon, sogKn: other.sog, cogDeg: other.cog },
    (own.time.getTime() - other.time.getTime()) / 60_000,
  );
  const result = computeCpaTcpa(
    { lat: own.lat, lon: own.lon, sogKn: own.sog, cogDeg: own.cog },
    { ...aligned, sogKn: other.sog, cogDeg: other.cog },
  );
  const [a, b] = own.mmsi < other.mmsi ? [own, other] : [other, own];
  return {
    cpaNm: result.cpaNm,
    tcpaMin: result.tcpaMin,
    rangeNm: result.rangeNm,
    positions: { a: reportOf(a), b: reportOf(b) },
  };
}

/** The band behind an open alert's severity (seeds the hysteresis after a restart). */
function riskOfSeverity(
  severity: AlertSeverity | undefined,
): CollisionRisk | undefined {
  if (severity === 'critical') return 'high';
  if (severity === 'warning') return 'medium';
  return undefined;
}

/**
 * Collision risk between vessel pairs (spec §13.7, method
 * `collision.cpa_tcpa`). For each moving vessel, candidates within
 * `COLLISION_SEARCH_RADIUS_NM` seen within `COLLISION_MAX_AGE_S` are
 * assessed from their relative motion (CPA in nm, TCPA in minutes); a pair
 * is excluded when either vessel is predicted at anchor, reports moored / at
 * anchor / aground, has no usable SOG/COG or sails slower than
 * `COLLISION_MIN_SOG_KN`, and when the vessels diverge (TCPA < 0). Pairs get
 * the bands high / medium / low with hysteresis; `high` raises a `critical`
 * and `medium` a `warning` alert with `dedupKey = collision:<minMmsi>:<maxMmsi>`
 * (escalation publishes again, nothing is published while the band holds),
 * resolved when the pair falls below `medium`, diverges, leaves the search
 * radius or stops reporting. Each vessel's state gets its highest band and
 * closest encounter; samples of pairs at risk go to the `encounters` table.
 *
 * Positions of one vessel are handled in order, different vessels
 * concurrently: every decision reads the tracker state at the time it is
 * made, and alert operations of one key are serialized by the emitter. The
 * tracker starts over whenever this instance becomes the active one
 * (`onActivated`, after the runner reloaded the open alerts from `events`),
 * seeded by the open alerts like after a restart. Resolutions are announced
 * with `alert.resolved.v1` by the runner (after the alert cooldown since the
 * last raise).
 *
 * @method collision.cpa_tcpa
 * @see docs/METHODOLOGY.md §6.1 (`collision.cpa_tcpa`)
 * @see lenart-2015-collision-threat, imo-msc-192-79, imo-colreg-1972
 */
@RegisterDetector()
@Injectable()
export class CollisionDetector implements Detector<CollisionConfig> {
  readonly id = 'collision';
  readonly domain = 'safety';
  readonly methodIds = [COLLISION_METHOD_ID];
  readonly alertTypes = [COLLISION_ALERT_TYPE] as const;
  readonly configSchema = collisionConfigSchema;
  readonly tickIntervalMs = COLLISION_TICK_MS;

  private readonly tracker = new EncounterTracker();
  /** Per vessel: event time of its last collision report (kept monotonic). */
  private readonly reportedAt = new Map<number, number>();
  /**
   * Event time of the first position of this active period: the grace
   * period of restored alerts whose pair is not evaluated again (their
   * `lastOccurredAt` may lie before an outage).
   */
  private activeSince: number | undefined;

  constructor(
    @Inject(SAFETY_STATE_SINK) private readonly states: SafetyStateSink,
    @Inject(ENCOUNTER_SINK) private readonly encounters: EncounterSink,
    private readonly metrics: SafetyMetrics,
  ) {}

  onPosition(
    context: DetectorContext<CollisionConfig>,
    position: VesselPosition,
  ): Promise<void> {
    return this.evaluate(context, position);
  }

  /**
   * This instance became the active one (startup or failover; the runner
   * reloaded the open alerts first): the pair tracker starts over, so pairs
   * another instance followed meanwhile get new encounters, seeded by the
   * open alerts' severities.
   */
  onActivated(): void {
    this.tracker.clear();
    this.reportedAt.clear();
    this.activeSince = undefined;
    this.metrics.trackedPairs(this.tracker.counts());
  }

  /**
   * Housekeeping in event time (only on the active instance): closes pairs
   * not evaluated within `COLLISION_MAX_AGE_S` (neither vessel reported) and
   * resolves open alerts whose pair is not tracked and whose last signal
   * (`OpenAlert.lastOccurredAt`) is older than that window (restored at
   * startup or after a takeover, or left open by a failed resolution).
   */
  onTick(context: DetectorContext<CollisionConfig>): Promise<void> {
    return this.housekeeping(context);
  }

  private async evaluate(
    context: DetectorContext<CollisionConfig>,
    position: VesselPosition,
  ): Promise<void> {
    const { config } = context;
    this.activeSince ??= position.time.getTime();
    const before = new Map<number, VesselCollisionSummary>();
    const remember = (mmsi: number): void => {
      if (!before.has(mmsi)) before.set(mmsi, this.tracker.summaryOf(mmsi));
    };
    remember(position.mmsi);

    const transitions: EncounterTransition[] = [];
    const orphans: string[] = [];
    const evaluated = new Set<string>();
    const ownExclusion = collisionExclusion(position, config.MIN_SOG_KN);
    if (ownExclusion === null) {
      const neighbours = context.pairs.neighbours(position, {
        radiusM: config.SEARCH_RADIUS_NM * METERS_PER_NM,
        maxAgeMs: config.MAX_AGE_S * 1000,
        filter: (point) =>
          collisionExclusion(point, config.MIN_SOG_KN) === null,
      });
      for (const { point: other } of neighbours) {
        const key = collisionDedupKey(position.mmsi, other.mmsi);
        evaluated.add(key);
        remember(other.mmsi);
        const tracked = this.tracker.get(key);
        const measurement = {
          ...measurePair(position, other),
          at: position.time,
        };
        const risk = assessCollisionRisk(
          measurement,
          tracked?.risk ?? riskOfSeverity(context.alerts.get(key)?.severity),
          collisionBands(config),
          config.HYSTERESIS,
        );
        const transition = this.tracker.apply(
          key,
          Math.min(position.mmsi, other.mmsi),
          Math.max(position.mmsi, other.mmsi),
          risk,
          measurement,
          config.SAMPLE_INTERVAL_S * 1000,
        );
        if (transition !== undefined) transitions.push(transition);
        else if (tracked === undefined && context.alerts.isOpen(key))
          orphans.push(key);
      }
    }
    for (const key of this.tracker.keysOf(position.mmsi)) {
      if (evaluated.has(key)) continue;
      const closed = this.tracker.close(key);
      if (closed === undefined) continue;
      remember(closed.mmsiA);
      remember(closed.mmsiB);
      transitions.push(closed);
    }

    const end: PairEnd =
      ownExclusion === null
        ? {
            reason:
              'pair left the search radius, stopped reporting or was excluded',
            text: localizable(MESSAGE_KEYS.collisionResolvedPairLost),
          }
        : {
            reason: `vessel ${position.mmsi} excluded (${ownExclusion})`,
            text: localizable(MESSAGE_KEYS.collisionResolvedExcluded, {
              mmsi: position.mmsi,
              exclusion: ownExclusion,
            }),
          };
    await this.settle(context, transitions, position.time, end);
    for (const key of orphans) {
      await context.alerts.resolve(key, {
        at: position.time,
        reason: 'no collision risk',
        data: { ...localizable(MESSAGE_KEYS.collisionResolvedNoRisk) },
      });
    }
    this.report(context, before, position.time, position);
    await this.store(transitions);
  }

  private async housekeeping(
    context: DetectorContext<CollisionConfig>,
  ): Promise<void> {
    const eventTime = context.pairs.eventTime;
    if (eventTime === undefined) return;
    const cutoff = eventTime.getTime() - context.config.MAX_AGE_S * 1000;
    const before = new Map<number, VesselCollisionSummary>();
    const transitions: EncounterTransition[] = [];
    for (const stale of this.tracker.staleBefore(new Date(cutoff))) {
      for (const mmsi of [stale.mmsiA, stale.mmsiB])
        if (!before.has(mmsi)) before.set(mmsi, this.tracker.summaryOf(mmsi));
      const closed = this.tracker.close(stale.key);
      if (closed !== undefined) transitions.push(closed);
    }
    await this.settle(context, transitions, eventTime, {
      reason: `not evaluated for ${context.config.MAX_AGE_S} s`,
      text: localizable(MESSAGE_KEYS.collisionResolvedStale, {
        maxAgeS: context.config.MAX_AGE_S,
      }),
    });

    // Event time against event time: lastOccurredAt is the event time of the
    // occurrence's latest signal (lastSeenAt would be the emitter's wall clock).
    const graceStart = this.activeSince ?? eventTime.getTime();
    for (const open of context.alerts.open()) {
      if (this.tracker.has(open.dedupKey)) continue;
      const lastSignal = (open.lastOccurredAt ?? open.openedAt).getTime();
      if (Math.max(lastSignal, graceStart) >= cutoff) continue;
      await context.alerts.resolve(open.dedupKey, {
        at: eventTime,
        reason: 'pair no longer evaluated',
        data: { ...localizable(MESSAGE_KEYS.collisionResolvedNotEvaluated) },
      });
    }
    this.report(context, before, eventTime);
    for (const [mmsi, at] of this.reportedAt)
      if (at < cutoff && this.tracker.keysOf(mmsi).length === 0)
        this.reportedAt.delete(mmsi);
    this.metrics.trackedPairs(this.tracker.counts());
  }

  /** Raises or resolves the alerts of the changed pairs from the tracker's current state. */
  private async settle(
    context: DetectorContext<CollisionConfig>,
    transitions: readonly EncounterTransition[],
    at: Date,
    close: PairEnd,
  ): Promise<void> {
    for (const transition of transitions) {
      const severityAfter = collisionRiskAlertSeverity(transition.after);
      const severityBefore = collisionRiskAlertSeverity(transition.before);
      // An alert restored at startup may be open although the tracker never saw the pair.
      if (
        severityAfter === null &&
        severityBefore === null &&
        !context.alerts.isOpen(transition.key)
      )
        continue;
      // Read the tracker now: a concurrent call may have moved the pair since.
      const current = this.tracker.get(transition.key);
      const severity =
        current === undefined ? null : collisionRiskAlertSeverity(current.risk);
      if (current !== undefined && severity !== null) {
        await context.alerts.raise(this.signal(context, current, severity));
      } else {
        const measurement = transition.measurement;
        const risk = current?.risk ?? 'none';
        await context.alerts.resolve(transition.key, {
          at,
          reason:
            measurement === undefined
              ? close.reason
              : `risk ${risk} (CPA ${fixed(measurement.cpaNm, 2)} nm, TCPA ${measurement.tcpaMin === null ? 'n/a' : `${fixed(measurement.tcpaMin, 1)} min`})`,
          data:
            measurement === undefined
              ? { risk: 'none', ...close.text }
              : {
                  risk,
                  cpaNm: measurement.cpaNm,
                  tcpaMin: measurement.tcpaMin,
                  rangeNm: measurement.rangeNm,
                  ...localizable(MESSAGE_KEYS.collisionResolvedRisk, {
                    risk,
                    cpaM: metresOfNm(measurement.cpaNm),
                    cpaNm: rounded(measurement.cpaNm, 2),
                    // Absent without relative motion (the text says "n/a").
                    ...(measurement.tcpaMin === null
                      ? {}
                      : { tcpaMin: rounded(measurement.tcpaMin, 1) }),
                  }),
                },
        });
      }
    }
  }

  /** Reports the collision part of the vessels whose summary changed (always the evaluated vessel). */
  private report(
    context: DetectorContext<CollisionConfig>,
    before: ReadonlyMap<number, VesselCollisionSummary>,
    at: Date,
    own?: VesselPosition,
  ): void {
    for (const [mmsi, previous] of before) {
      const summary = this.tracker.summaryOf(mmsi);
      if (mmsi !== own?.mmsi && sameCollisionCategory(previous, summary))
        continue;
      const state = mmsi === own?.mmsi ? own : context.vessels.get(mmsi);
      if (state === undefined) continue;
      const evaluatedAt = Math.max(
        at.getTime(),
        this.reportedAt.get(mmsi) ?? 0,
      );
      this.reportedAt.set(mmsi, evaluatedAt);
      this.states.report({
        mmsi,
        kinematics: kinematicsOf(state),
        collision: {
          collisionRisk: summary.risk,
          closestEncounter: summary.closest,
          evaluatedAt: new Date(evaluatedAt),
        },
      });
    }
  }

  /** Stores the samples of the transitions (best effort). */
  private async store(
    transitions: readonly EncounterTransition[],
  ): Promise<void> {
    const samples: EncounterSample[] = [];
    for (const transition of transitions) {
      const { measurement } = transition;
      if (!transition.sample || measurement === undefined) continue;
      samples.push({
        time: measurement.at,
        mmsiA: transition.mmsiA,
        mmsiB: transition.mmsiB,
        encounterId: transition.encounterId,
        cpaNm: measurement.cpaNm,
        tcpaMin: measurement.tcpaMin,
        rangeNm: measurement.rangeNm,
        risk: transition.after,
        positions: measurement.positions,
      });
    }
    await this.encounters.record(samples);
  }

  private signal(
    context: DetectorContext<CollisionConfig>,
    encounter: TrackedEncounter,
    severity: AlertSeverity,
  ) {
    const { measurement } = encounter;
    const { a, b } = measurement.positions;
    const labelA = vesselLabel(a.mmsi, context.fleet.byMmsi(a.mmsi)?.name);
    const labelB = vesselLabel(b.mmsi, context.fleet.byMmsi(b.mmsi)?.name);
    const bands = collisionBands(context.config);
    return {
      type: COLLISION_ALERT_TYPE,
      dedupKey: encounter.key,
      severity,
      mmsi: encounter.mmsiA,
      relatedMmsi: encounter.mmsiB,
      title: `${collisionRiskLabel(encounter.risk)} of collision: ${labelA} and ${labelB}`,
      message: `CPA ${fixed(measurement.cpaNm, 2)} nm in ${fixed(measurement.tcpaMin, 1)} min (range ${fixed(measurement.rangeNm, 2)} nm)`,
      position: { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 },
      occurredAt: measurement.at,
      zoneId: null,
      data: {
        methodId: COLLISION_METHOD_ID,
        risk: encounter.risk,
        cpaNm: measurement.cpaNm,
        tcpaMin: measurement.tcpaMin,
        rangeNm: measurement.rangeNm,
        encounterId: encounter.encounterId,
        thresholds: { ...bands, hysteresis: context.config.HYSTERESIS },
        positions: measurement.positions,
        ...localizable(MESSAGE_KEYS.collisionRisk, {
          vesselA: labelA,
          mmsiA: a.mmsi,
          vesselB: labelB,
          mmsiB: b.mmsi,
          risk: encounter.risk,
          cpaM: metresOfNm(measurement.cpaNm),
          cpaNm: rounded(measurement.cpaNm, 2),
          tcpaMin: rounded(measurement.tcpaMin, 1),
          rangeM: metresOfNm(measurement.rangeNm),
          rangeNm: rounded(measurement.rangeNm, 2),
        }),
      },
    } as const;
  }
}
