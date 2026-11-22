import type { AlertRaisedV1 } from '@darmawanweb/ais-its-contracts/events';
import type {
  AlertPersistence,
  AlertResolution,
  AlertUpdate,
  OpenAlert,
} from '@darmawanweb/ais-its-nest/analytics';
import {
  type Database,
  InjectDb,
  pointGeography,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import * as schema from '../db/schema.js';
import { supersededText } from './alert-text.js';
import { detectorOfAlertType } from './alert-types.js';

const { events } = schema;

type Transaction = Parameters<
  Parameters<Database<typeof schema>['transaction']>[0]
>[0];

/**
 * First key of the transaction-scoped advisory lock that serializes the
 * writes opening a row of one `dedup_key` (second key: `hashtext(dedup_key)`).
 * The two-key form never collides with the single-key locks of the kit's
 * migrator.
 */
export const ALERT_KEY_LOCK_CLASS = 0x5afe_0001;

/**
 * The `events` table as the Detector SDK's persistence hook (spec §18). The
 * emitter calls it BEFORE publishing, so every published alert (and every
 * published resolution) has its row; each method is idempotent because
 * deliveries, restarts and failovers repeat calls.
 *
 * Invariant: at most one `open` row per `dedup_key`. Every write that opens
 * a row (a new alert, an escalation, a reopened occurrence) runs under a
 * per-key advisory lock and resolves any other open row of the key as
 * superseded. The kit serializes a key within one instance and reloads the
 * open rows ({@link loadOpen}) whenever an instance becomes the active one;
 * the database invariant covers what an in-process queue cannot, e.g. an
 * instance that lost its pin while it was still finishing a position.
 *
 * `last_seen_at` is event time throughout and never moves back: the alert's
 * `occurredAt` when a row is written, then the event time of every later
 * signal of the condition — de-escalations and reopenings
 * ({@link onUpdated}) and unchanged repeats ({@link onRepeated}, at most every
 * `alertRepeatedIntervalMs` = 60 s per key); a resolution sets `resolved_at`
 * only.
 */
@Injectable()
export class DetectorEventsRepository implements AlertPersistence {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** Inserts the alert and resolves the open row(s) it supersedes (escalation, stale duplicate). */
  async onRaised(
    alert: AlertRaisedV1,
    outcome: 'raised' | 'escalated',
  ): Promise<void> {
    const occurredAt = new Date(alert.occurredAt);
    await this.db.transaction(async (tx) => {
      await lockKey(tx, alert.dedupKey);
      const superseded = await supersede(tx, alert.dedupKey, alert.id, {
        at: occurredAt,
        reason: outcome === 'escalated' ? 'escalated' : 'superseded',
        detector: detectorOfAlertType(alert.type),
      });
      // The occurrence started with the oldest row it continues.
      let openedAt = occurredAt;
      for (const row of superseded)
        if (row.openedAt < openedAt) openedAt = row.openedAt;
      await tx
        .insert(events)
        .values({
          id: alert.id,
          time: occurredAt,
          detector: detectorOfAlertType(alert.type),
          type: alert.type,
          domain: alert.domain,
          severity: alert.severity,
          currentSeverity: alert.severity,
          mmsi: alert.mmsi,
          relatedMmsi: alert.relatedMmsi,
          zoneId: alert.zoneId,
          geom:
            alert.lat === null || alert.lon === null
              ? null
              : pointGeography(alert.lon, alert.lat),
          title: alert.title,
          message: alert.message,
          methodId: alert.methodId,
          dedupKey: alert.dedupKey,
          data: alert.data,
          status: 'open',
          openedAt,
          lastSeenAt: occurredAt,
        })
        .onConflictDoNothing();
    });
  }

  /**
   * A de-escalation or a suppressed re-raise, which may reopen the row:
   * the current severity and `last_seen_at` = the signal's event time
   * (`update.occurredAt`; `update.at` is the emitter's wall clock).
   */
  async onUpdated(update: AlertUpdate): Promise<void> {
    const { alert, occurredAt } = update;
    // The emitter always sets occurredAt; without it last_seen_at stays as is.
    const seen =
      occurredAt === undefined ? {} : { lastSeenAt: seenAtLeast(occurredAt) };
    if (!update.reopened) {
      await this.db
        .update(events)
        .set({ currentSeverity: alert.severity, ...seen })
        .where(eq(events.id, alert.alertId));
      return;
    }
    await this.db.transaction(async (tx) => {
      await lockKey(tx, alert.dedupKey);
      await supersede(tx, alert.dedupKey, alert.alertId, {
        at: occurredAt ?? update.at,
        reason: 'superseded',
        detector: alert.detector ?? detectorOfAlertType(alert.type),
      });
      await tx
        .update(events)
        .set({
          currentSeverity: alert.severity,
          status: 'open',
          resolvedAt: null,
          resolution: null,
          ...seen,
        })
        .where(eq(events.id, alert.alertId));
    });
  }

  /**
   * An unchanged signal of the open occurrence (throttled by the runner's
   * `alertRepeatedIntervalMs`, 60 s of event time per key): moves
   * `last_seen_at` forward to `occurredAt`, never back (redeliveries and
   * the throttle's first signal may be older).
   */
  async onRepeated(alert: OpenAlert, occurredAt: Date): Promise<void> {
    await this.db
      .update(events)
      .set({ lastSeenAt: seenAtLeast(occurredAt) })
      .where(
        and(
          // The partial index of open rows (events_open_idx) finds the row.
          eq(events.dedupKey, alert.dedupKey),
          eq(events.status, 'open'),
          eq(events.id, alert.alertId),
        ),
      );
  }

  /**
   * Marks the open row of the occurrence resolved (no-op when it is already
   * resolved). The emitter then announces the end with `alert.resolved.v1`
   * once the key's cooldown since its last raise is over.
   */
  async onResolved(resolution: AlertResolution): Promise<void> {
    await this.db
      .update(events)
      .set({
        status: 'resolved',
        resolvedAt: resolution.resolvedAt,
        resolution: { ...resolution.data, reason: resolution.reason ?? null },
      })
      .where(
        and(eq(events.id, resolution.alert.alertId), eq(events.status, 'open')),
      );
  }

  /**
   * Open occurrences with their owning detector, domain, method and event
   * times, restored at startup and reloaded by the runner whenever this
   * instance becomes the active one (failover), so neither re-raises them
   * or misses their resolutions. Oldest first: should a key still have two
   * open rows, the newest wins.
   */
  async loadOpen(): Promise<readonly OpenAlert[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(eq(events.status, 'open'))
      .orderBy(asc(events.createdAt));
    return rows.map((row) => ({
      alertId: row.id,
      dedupKey: row.dedupKey,
      type: row.type,
      mmsi: row.mmsi,
      relatedMmsi: row.relatedMmsi,
      zoneId: row.zoneId,
      severity: row.currentSeverity,
      publishedSeverity: row.severity,
      openedAt: row.openedAt,
      // The row is written right before the alert is published.
      publishedAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      // Event times of the occurrence (both columns store signal times).
      firstOccurredAt: row.openedAt,
      lastOccurredAt: row.lastSeenAt,
      // Carried by the occurrence's alert.resolved.v1.
      domain: row.domain,
      methodId: row.methodId,
      detector: row.detector,
    }));
  }
}

/** `last_seen_at` moved forward to `at` (never back). */
function seenAtLeast(at: Date) {
  return sql`GREATEST(${events.lastSeenAt}, ${at})`;
}

/** Serializes, until the transaction ends, the writes that open a row of `dedupKey`. */
async function lockKey(tx: Transaction, dedupKey: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${ALERT_KEY_LOCK_CLASS}, hashtext(${dedupKey}))`,
  );
}

/** Resolves the open rows of `dedupKey` other than `keepId`; returns their opening times. */
function supersede(
  tx: Transaction,
  dedupKey: string,
  keepId: string,
  resolution: {
    readonly at: Date;
    readonly reason: 'escalated' | 'superseded';
    /** Detector of the key (the text's `messageKey`). */
    readonly detector: string;
  },
): Promise<{ openedAt: Date }[]> {
  return tx
    .update(events)
    .set({
      status: 'resolved',
      resolvedAt: resolution.at,
      resolution: {
        reason: resolution.reason,
        supersededBy: keepId,
        ...supersededText(resolution.detector, resolution.reason),
      },
    })
    .where(
      and(
        eq(events.dedupKey, dedupKey),
        eq(events.status, 'open'),
        ne(events.id, keepId),
      ),
    )
    .returning({ openedAt: events.openedAt });
}
