import { InjectConfig } from '@darmawanweb/ais-its-nest';
import {
  AlertEmitter,
  DETECTOR_CLOCK,
  DetectorRegistry,
  type OpenAlert,
} from '@darmawanweb/ais-its-nest/analytics';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { SafetyMetrics } from '../common/safety.metrics.js';
import type { Config } from '../config.js';
import {
  DetectorEventsRepository,
  RESOLVED_ELSEWHERE,
} from './detector-events.repository.js';

/** How the detectors run their calls (implemented by {@link AlertStateSync}). */
export interface DetectorGate {
  /** Runs the body of an `onPosition` call. */
  position<T>(call: () => Promise<T>): Promise<T>;
  /** Runs the body of any other call (`onTick`, `onZoneChanged`, `onVesselChanged`). */
  run<T>(call: () => Promise<T>): Promise<T>;
  /** Registers a reset of detector-local state, run when a resync changed the alert state. */
  onReset(reset: () => void): void;
}

/** Injection token of the {@link DetectorGate}. */
export const DETECTOR_GATE = 'SAFETY_DETECTOR_GATE';

/**
 * Gap between two positions after which the alert state is reloaded, ms:
 * half the pinned TTL of the exclusive position consumer. NATS moves the
 * consumer to another instance only after the active one pulled nothing for
 * the pinned TTL, so an instance that takes over always sees a longer gap.
 */
export function resyncGapMs(pinnedTtlMs: number): number {
  return Math.floor(pinnedTtlMs / 2);
}

/** What one resync changed in the emitter. */
export interface AlertStateResync {
  /** Open occurrences taken from the `events` table (unknown here or changed elsewhere). */
  readonly restored: number;
  /** Occurrences open here that another instance resolved meanwhile. */
  readonly forgotten: number;
}

/**
 * LOCAL WORKAROUND for `@darmawanweb/ais-its-nest` 0.2.0 (reported as a
 * platform issue): the kit's `DetectorRunner` loads the open alerts into
 * the `AlertEmitter` only at boot, and nothing reloads them when an
 * exclusive standby becomes the active instance. Such an instance would
 * keep the open-alert set it saw at boot: it raised again what the previous
 * instance had raised since (a second alert and a second open row), and
 * ignored what that instance had resolved (`unchanged` — the alert was
 * never raised again).
 *
 * Every detector call runs through this gate. The first position after boot
 * and the first after a gap of {@link resyncGapMs} without positions
 * (nothing else can precede a takeover; a stalled feed costs one cheap
 * query) first wait until no detector call is running, then reload the open
 * occurrences of the enabled detectors from the `events` table: occurrences
 * open here but not there were resolved by another instance and are
 * forgotten (no write: {@link RESOLVED_ELSEWHERE}), open rows unknown here
 * or changed (alert id, severity) are restored. When anything changed,
 * another instance was active, so the detectors drop their local state
 * ({@link onReset}) and rebuild it from new positions, seeded by the open
 * occurrences — like after a restart. Calls arriving meanwhile wait; a
 * failed reload fails them and is retried by the next call.
 *
 * Not covered without kit support: an old instance still finishing its
 * in-flight positions while the new one starts (bounded by the repository's
 * one-open-row-per-key invariant), and a pin moved twice within the gap by
 * NATS server restarts. Run one replica (README "Deployment") until the kit
 * reloads the state on `consumer_pinned` itself.
 */
@Injectable()
export class AlertStateSync implements DetectorGate {
  private readonly logger = new Logger(AlertStateSync.name);
  private readonly gapMs: number;
  private readonly resets: (() => void)[] = [];
  private readonly idleWaiters: (() => void)[] = [];
  /** Clock time of the latest position call (start or end), ms. */
  private lastPositionAt: number | undefined;
  private needed = false;
  private resyncing: Promise<void> | undefined;
  private running = 0;

  constructor(
    private readonly alerts: AlertEmitter,
    private readonly registry: DetectorRegistry,
    @Inject(DetectorEventsRepository)
    private readonly events: Pick<DetectorEventsRepository, 'loadOpen'>,
    private readonly metrics: SafetyMetrics,
    @InjectConfig() config: Pick<Config, 'DETECTOR_PINNED_TTL_MS'>,
    @Inject(DETECTOR_CLOCK) private readonly clock: () => Date,
  ) {
    this.gapMs = resyncGapMs(config.DETECTOR_PINNED_TTL_MS);
  }

  /** @inheritdoc */
  async position<T>(call: () => Promise<T>): Promise<T> {
    const now = this.clock().getTime();
    if (
      this.lastPositionAt === undefined ||
      now - this.lastPositionAt >= this.gapMs
    )
      this.needed = true;
    this.lastPositionAt = now;
    try {
      return await this.run(call);
    } finally {
      // A slow call (or resync) is activity too, not a gap.
      this.lastPositionAt = this.clock().getTime();
    }
  }

  /** @inheritdoc */
  async run<T>(call: () => Promise<T>): Promise<T> {
    while (this.needed || this.resyncing !== undefined) {
      this.resyncing ??= this.resync().finally(() => {
        this.resyncing = undefined;
      });
      await this.resyncing;
    }
    this.running += 1;
    try {
      return await call();
    } finally {
      this.running -= 1;
      if (this.running === 0)
        for (const wake of this.idleWaiters.splice(0)) wake();
    }
  }

  /** @inheritdoc */
  onReset(reset: () => void): void {
    this.resets.push(reset);
  }

  private async resync(): Promise<void> {
    await this.idle();
    let result: AlertStateResync;
    try {
      result = await this.reload();
    } catch (error) {
      this.metrics.alertResyncs.inc({ outcome: 'failed' });
      this.logger.error(
        `Reloading the open alerts failed (retried by the next call): ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    this.needed = false;
    if (result.restored === 0 && result.forgotten === 0) {
      this.metrics.alertResyncs.inc({ outcome: 'unchanged' });
      return;
    }
    for (const reset of this.resets) reset();
    this.metrics.alertResyncs.inc({ outcome: 'changed' });
    this.logger.log(
      `Another instance was active: reloaded the open alerts (${result.restored} restored, ${result.forgotten} resolved elsewhere) and reset the detector state`,
    );
  }

  /** Aligns the emitter with the open rows of the enabled detectors. */
  private async reload(): Promise<AlertStateResync> {
    const enabled = new Set(
      this.registry.enabled.map((entry) => entry.descriptor.id),
    );
    const owned = (alert: OpenAlert): boolean =>
      alert.detector !== undefined && enabled.has(alert.detector);
    const stored = new Map<string, OpenAlert>();
    for (const alert of await this.events.loadOpen())
      if (owned(alert)) stored.set(alert.dedupKey, alert);

    let forgotten = 0;
    for (const open of this.alerts.openAlerts()) {
      if (!owned(open) || stored.has(open.dedupKey)) continue;
      const ended = await this.alerts.resolve(open.dedupKey, {
        reason: RESOLVED_ELSEWHERE,
        accept: (current) => current.alertId === open.alertId,
      });
      if (ended) forgotten += 1;
    }
    const restored = [...stored.values()].filter((alert) => {
      const current = this.alerts.get(alert.dedupKey);
      return (
        current?.alertId !== alert.alertId ||
        current.severity !== alert.severity
      );
    });
    this.alerts.restore(restored);
    return { restored: restored.length, forgotten };
  }

  /** Resolves when no detector call is running. */
  private idle(): Promise<void> {
    if (this.running === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
