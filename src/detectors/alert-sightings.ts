import type { AlertOutcome } from '@darmawanweb/ais-its-nest/analytics';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { DetectorEventsRepository } from './detector-events.repository.js';

/**
 * Minimum event-time interval between two recorded sightings of a condition
 * whose severity did not change, ms: `events.last_seen_at` lags the latest
 * signal by less than this while the condition lasts.
 */
export const SIGHTING_INTERVAL_MS = 60_000;

/** Keys whose last sighting is remembered before the throttle starts over. */
const MAX_REMEMBERED_KEYS = 10_000;

/** Where detectors report the outcome of each alert signal (implemented by {@link AlertSightings}). */
export interface AlertSightingSink {
  /**
   * Records that the condition `dedupKey` was observed at `seenAt` (event
   * time) with this emitter outcome. Never throws.
   */
  record(dedupKey: string, seenAt: Date, outcome: AlertOutcome): Promise<void>;
}

/** Injection token of the {@link AlertSightingSink}. */
export const ALERT_SIGHTINGS = 'SAFETY_ALERT_SIGHTINGS';

/**
 * Keeps `events.last_seen_at` on the event time of the latest signal of an
 * open condition. The emitter persists new alerts and escalations (their row
 * carries `occurredAt`) and de-escalations / reopenings (with its wall
 * clock), but never repeats of an unchanged severity, so a warning lasting
 * hours would keep its opening time. De-escalations and reopenings are
 * recorded at once, repeats at most every {@link SIGHTING_INTERVAL_MS} per
 * key. Best effort: a failed write is logged and the next sighting retries.
 */
@Injectable()
export class AlertSightings implements AlertSightingSink {
  private readonly logger = new Logger(AlertSightings.name);
  /** Event time of the last recorded sighting per key, ms. */
  private readonly recorded = new Map<string, number>();

  constructor(
    @Inject(DetectorEventsRepository)
    private readonly events: Pick<DetectorEventsRepository, 'recordSighting'>,
  ) {}

  /** @inheritdoc */
  async record(
    dedupKey: string,
    seenAt: Date,
    outcome: AlertOutcome,
  ): Promise<void> {
    const at = seenAt.getTime();
    if (outcome === 'raised' || outcome === 'escalated') {
      // The new row was written with this time.
      this.remember(dedupKey, at);
      return;
    }
    const last = this.recorded.get(dedupKey);
    if (
      outcome === 'unchanged' &&
      last !== undefined &&
      at - last < SIGHTING_INTERVAL_MS
    )
      return;
    try {
      await this.events.recordSighting(dedupKey, seenAt);
      this.remember(dedupKey, at);
    } catch (error) {
      this.logger.warn(
        `Recording the sighting of ${dedupKey} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private remember(dedupKey: string, at: number): void {
    if (
      this.recorded.size >= MAX_REMEMBERED_KEYS &&
      !this.recorded.has(dedupKey)
    )
      this.recorded.clear();
    this.recorded.set(
      dedupKey,
      Math.max(at, this.recorded.get(dedupKey) ?? at),
    );
  }
}
