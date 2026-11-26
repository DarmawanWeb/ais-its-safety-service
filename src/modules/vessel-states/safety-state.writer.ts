import type { SafetyVesselStateV1 } from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { sanitizeError } from '@darmawanweb/ais-its-nest/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { SafetyMetrics } from '../../common/safety.metrics.js';
import type { Config } from '../../config.js';
import {
  type CollisionReset,
  collisionResetPart,
  mergeSafetyReports,
  newerCollisionPart,
  publicationReason,
  type PublicationReason,
  type SafetyStateReport,
} from '../../domain/safety-state.js';
import {
  type SafetyStatePublication,
  SafetyStatePublisher,
} from './safety-state.publisher.js';
import type { SafetyStateSink } from './safety-state.sink.js';
import {
  type StoredSafetyState,
  VesselStatesRepository,
} from './vessel-states.repository.js';

/** The repository operations the writer needs. */
export type SafetyStateStore = Pick<
  VesselStatesRepository,
  'upsertReports' | 'resetCollision' | 'markPublished'
>;

/** Vessels written per statement. */
export const STATE_BATCH_SIZE = 500;

/** Concurrent publications of one batch. */
const PUBLISH_CONCURRENCY = 64;

/** First and longest pause after a failed write, ms. */
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 30_000;

/**
 * Materializes the detectors' reports into `vessel_state` and publishes the
 * `SAFETY` stream (spec §13.7) — the producer of
 * `safety.vessel_state.updated.v1`.
 *
 * Reports are queued per vessel and merged part by part (newest kinematics,
 * newest EWS part, newest collision part), then written in batches every
 * `SAFETY_STATE_FLUSH_MS` (or as soon as {@link STATE_BATCH_SIZE} vessels
 * wait) with one upsert that merges each part with the stored row, so
 * detectors deployed separately (`DETECTORS`) complete each other's state.
 * The merged rows decide the publication: on a material change, otherwise
 * at most every `SAFETY_STATE_HEARTBEAT_S` of event time. A failed write
 * keeps the reports (newer ones win) and retries with exponential backoff;
 * a failed publication is retried by the vessel's next report.
 *
 * A collision reset ({@link CollisionReset}: a band no evaluation backs any
 * more) becomes the collision part of the vessel's pending report, newest
 * part winning and the later call on a tie; without a pending report it
 * waits on its own and is written after each round's batch of reports, with
 * one guarded update per batch that changes only stored rows whose collision
 * part is not newer, and the changed rows are published like the upserted
 * ones.
 *
 * `vessel_state` is a latest-state cache: positions are acknowledged before
 * their state is written, so a crash loses at most the last flush interval,
 * which the vessels' next positions restore.
 */
@Injectable()
export class SafetyStateWriter
  implements SafetyStateSink, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SafetyStateWriter.name);
  private readonly pending = new Map<number, SafetyStateReport>();
  /** Collision resets of vessels without a pending report. */
  private readonly resets = new Map<number, CollisionReset>();
  private readonly heartbeatMs: number;
  private readonly flushIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private failures = 0;
  private retryAt = 0;

  constructor(
    @Inject(VesselStatesRepository) private readonly store: SafetyStateStore,
    @Inject(SafetyStatePublisher)
    private readonly publisher: SafetyStatePublication,
    private readonly metrics: SafetyMetrics,
    @InjectConfig() config: Config,
  ) {
    this.heartbeatMs = config.SAFETY_STATE_HEARTBEAT_S * 1000;
    this.flushIntervalMs = config.SAFETY_STATE_FLUSH_MS;
  }

  /** Queues a report (merged with a pending report or collision reset of the same vessel). */
  report(report: SafetyStateReport): void {
    const reset = this.resets.get(report.mmsi);
    this.resets.delete(report.mmsi);
    const incoming = reset === undefined ? report : afterReset(reset, report);
    const queued = this.pending.get(report.mmsi);
    this.pending.set(
      report.mmsi,
      queued === undefined ? incoming : mergeSafetyReports(queued, incoming),
    );
    this.queued();
  }

  /** Queues a collision reset (the collision part of a pending report of the vessel, if any). */
  resetCollision(reset: CollisionReset): void {
    const queued = this.pending.get(reset.mmsi);
    if (queued === undefined) {
      this.resets.set(
        reset.mmsi,
        newerReset(this.resets.get(reset.mmsi), reset),
      );
    } else {
      // The reset is the later call: its part wins a tie.
      this.pending.set(reset.mmsi, withReset(queued, reset));
    }
    this.queued();
  }

  /** Vessels waiting to be written (reports and collision resets). */
  get pendingCount(): number {
    return this.pending.size + this.resets.size;
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.kick();
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  /**
   * Final flush. Runs after every `beforeApplicationShutdown` hook (the
   * detector runner has stopped) and before the global database and NATS
   * modules close their connections.
   */
  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  /** Writes and publishes everything queued now (shutdown, tests). */
  async flush(): Promise<void> {
    await this.running;
    this.retryAt = 0;
    await this.start();
  }

  private queued(): void {
    this.metrics.statesPending.set(this.pendingCount);
    if (this.pendingCount >= STATE_BATCH_SIZE) this.kick();
  }

  private kick(): void {
    if (this.running !== undefined || this.pendingCount === 0) return;
    if (Date.now() < this.retryAt) return;
    void this.start();
  }

  /** Runs one drain at a time, so two batches never race for one vessel. */
  private start(): Promise<void> {
    this.running ??= this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * Writes batches until nothing is pending or a write fails. Each round
   * writes a batch of reports, then one of the resets (taken once the
   * reports are stored, so a steady flow of reports never holds them back).
   */
  private async drain(): Promise<void> {
    while (this.pendingCount > 0) {
      const batch = this.take(STATE_BATCH_SIZE);
      if (
        batch.length > 0 &&
        !(await this.attempt(
          batch.length,
          () => this.store.upsertReports(batch),
          () => {
            this.requeue(batch);
          },
        ))
      )
        return;
      const resets = this.takeResets(STATE_BATCH_SIZE);
      if (
        resets.length > 0 &&
        !(await this.attempt(
          resets.length,
          () => this.store.resetCollision(resets),
          () => {
            this.requeueResets(resets);
          },
        ))
      )
        return;
    }
  }

  /**
   * Writes one batch and publishes its due rows; `false` when the write
   * failed: the batch is put back and retried after a backoff.
   */
  private async attempt(
    count: number,
    write: () => Promise<StoredSafetyState[]>,
    requeue: () => void,
  ): Promise<boolean> {
    const stopTimer = this.metrics.stateFlushDuration.startTimer();
    try {
      await this.publishStored(await write());
      this.failures = 0;
      return true;
    } catch (error) {
      requeue();
      this.failures += 1;
      const delay = Math.min(
        RETRY_MAX_MS,
        RETRY_MIN_MS * 2 ** (this.failures - 1),
      );
      this.retryAt = Date.now() + delay;
      this.metrics.stateFlushFailures.inc();
      // Database errors without bound values (the kit's error hygiene).
      const err = sanitizeError(error);
      this.logger.warn({
        msg: `Writing ${count} vessel state(s) failed (attempt ${this.failures}, retry in ${delay} ms): ${err instanceof Error ? err.message : String(err)}`,
        err,
      });
      return false;
    } finally {
      stopTimer();
      this.metrics.statesPending.set(this.pendingCount);
    }
  }

  private take(limit: number): SafetyStateReport[] {
    const batch: SafetyStateReport[] = [];
    for (const [mmsi, report] of this.pending) {
      if (batch.length >= limit) break;
      batch.push(report);
      this.pending.delete(mmsi);
    }
    return batch;
  }

  private takeResets(limit: number): CollisionReset[] {
    const batch: CollisionReset[] = [];
    for (const [mmsi, reset] of this.resets) {
      if (batch.length >= limit) break;
      batch.push(reset);
      this.resets.delete(mmsi);
    }
    return batch;
  }

  /** Puts a failed batch back; reports and resets queued meanwhile are newer and win. */
  private requeue(batch: readonly SafetyStateReport[]): void {
    for (const report of batch) {
      const newer = this.pending.get(report.mmsi);
      const reset = this.resets.get(report.mmsi);
      this.resets.delete(report.mmsi);
      const merged =
        newer === undefined ? report : mergeSafetyReports(report, newer);
      this.pending.set(
        report.mmsi,
        reset === undefined ? merged : withReset(merged, reset),
      );
    }
  }

  /** Puts failed resets back; reports and resets queued meanwhile are newer and win. */
  private requeueResets(batch: readonly CollisionReset[]): void {
    for (const reset of batch) {
      const queued = this.pending.get(reset.mmsi);
      if (queued === undefined) {
        const later = this.resets.get(reset.mmsi);
        this.resets.set(
          reset.mmsi,
          later === undefined ? reset : newerReset(reset, later),
        );
      } else {
        this.pending.set(reset.mmsi, afterReset(reset, queued));
      }
    }
  }

  /** Publishes the written rows that are due and records their publication. */
  private async publishStored(
    stored: readonly StoredSafetyState[],
  ): Promise<void> {
    const due = stored.flatMap((row) => this.due(row));
    const published = await this.publishAll(due);
    await this.store.markPublished(published);
  }

  private due(
    row: StoredSafetyState,
  ): { state: SafetyVesselStateV1; reason: PublicationReason }[] {
    const reason = publicationReason(
      row.published,
      row.state,
      this.heartbeatMs,
    );
    return reason === null ? [] : [{ state: row.state, reason }];
  }

  /** Publishes the due states; returns those that were stored by NATS. */
  private async publishAll(
    due: readonly { state: SafetyVesselStateV1; reason: PublicationReason }[],
  ): Promise<SafetyVesselStateV1[]> {
    const published: SafetyVesselStateV1[] = [];
    for (let start = 0; start < due.length; start += PUBLISH_CONCURRENCY) {
      const chunk = due.slice(start, start + PUBLISH_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map(({ state }) => this.publisher.publish(state)),
      );
      results.forEach((result, index) => {
        const item = chunk[index];
        if (item === undefined) return;
        if (result.status === 'fulfilled') {
          published.push(item.state);
          this.metrics.published(item.reason);
        } else {
          this.metrics.statePublishFailures.inc();
          this.logger.warn(
            `Publishing the safety state of ${item.state.mmsi} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
        }
      });
    }
    return published;
  }
}

/** `report` with `reset` as its later collision part (the newest part wins, the reset on a tie). */
function withReset(
  report: SafetyStateReport,
  reset: CollisionReset,
): SafetyStateReport {
  return {
    ...report,
    collision: newerCollisionPart(report.collision, collisionResetPart(reset)),
  };
}

/** `report` after `reset` (the newest collision part wins, the report's on a tie). */
function afterReset(
  reset: CollisionReset,
  report: SafetyStateReport,
): SafetyStateReport {
  return {
    ...report,
    collision: newerCollisionPart(collisionResetPart(reset), report.collision),
  };
}

/** The newer of two resets of one vessel (`later` on a tie). */
function newerReset(
  earlier: CollisionReset | undefined,
  later: CollisionReset,
): CollisionReset {
  return earlier !== undefined &&
    earlier.evaluatedAt.getTime() > later.evaluatedAt.getTime()
    ? earlier
    : later;
}
