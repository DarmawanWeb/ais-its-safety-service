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
 * Resolution reason of an occurrence that another instance already ended
 * (`AlertStateSync`): the emitter forgets it, {@link DetectorEventsRepository.onResolved}
 * writes nothing.
 */
export const RESOLVED_ELSEWHERE = 'resolved by another instance';

/**
 * The `events` table as the Detector SDK's persistence hook (spec §18). The
 * emitter calls it BEFORE publishing, so every published alert has a row;
 * each method is idempotent because deliveries and restarts repeat calls.
 *
 * Invariant: at most one `open` row per `dedup_key`. Every write that opens
 * a row (a new alert, an escalation, a reopened occurrence) runs under a
 * per-key advisory lock and resolves any other open row of the key as
 * superseded — so an instance that took over with a stale alert state (see
 * `AlertStateSync`) can never leave a second open row behind.
 *
 * `last_seen_at` is event time throughout: the alert's `occurredAt` when a
 * row is written, then the sightings of the condition
 * ({@link recordSighting}); a resolution sets `resolved_at` only.
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
   * A de-escalation or a suppressed re-raise, which may reopen the row. The
   * update carries the emitter's wall clock, not the signal's event time,
   * so `last_seen_at` is left to {@link recordSighting}.
   */
  async onUpdated(update: AlertUpdate): Promise<void> {
    const { alert } = update;
    if (!update.reopened) {
      await this.db
        .update(events)
        .set({ currentSeverity: alert.severity })
        .where(eq(events.id, alert.alertId));
      return;
    }
    await this.db.transaction(async (tx) => {
      await lockKey(tx, alert.dedupKey);
      await supersede(tx, alert.dedupKey, alert.alertId, {
        at: update.at,
        reason: 'superseded',
      });
      await tx
        .update(events)
        .set({
          currentSeverity: alert.severity,
          status: 'open',
          resolvedAt: null,
          resolution: null,
        })
        .where(eq(events.id, alert.alertId));
    });
  }

  /**
   * Marks the open row of the occurrence resolved (no-op when already
   * resolved, and for {@link RESOLVED_ELSEWHERE}: that row was resolved by
   * the instance that ended it).
   */
  async onResolved(resolution: AlertResolution): Promise<void> {
    if (resolution.reason === RESOLVED_ELSEWHERE) return;
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
   * Records that the open condition `dedupKey` was observed again at
   * `seenAt` (event time); `last_seen_at` never moves back.
   */
  async recordSighting(dedupKey: string, seenAt: Date): Promise<void> {
    await this.db
      .update(events)
      .set({ lastSeenAt: sql`GREATEST(${events.lastSeenAt}, ${seenAt})` })
      .where(and(eq(events.dedupKey, dedupKey), eq(events.status, 'open')));
  }

  /**
   * Open occurrences with their owning detector, restored at startup (and
   * by `AlertStateSync` after a takeover) so they are not raised again.
   * Oldest first: should a key still have two open rows, the newest wins.
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
      detector: row.detector,
    }));
  }
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
  resolution: { readonly at: Date; readonly reason: string },
): Promise<{ openedAt: Date }[]> {
  return tx
    .update(events)
    .set({
      status: 'resolved',
      resolvedAt: resolution.at,
      resolution: { reason: resolution.reason, supersededBy: keepId },
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
