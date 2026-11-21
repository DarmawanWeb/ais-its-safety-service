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
import { and, eq, ne } from 'drizzle-orm';

import * as schema from '../db/schema.js';
import { detectorOfAlertType } from './alert-types.js';

const { events } = schema;

/**
 * The `events` table as the Detector SDK's persistence hook (spec §18). The
 * emitter calls it BEFORE publishing, so every published alert has a row;
 * each method is idempotent because deliveries and restarts repeat calls.
 */
@Injectable()
export class DetectorEventsRepository implements AlertPersistence {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** Inserts the alert; an escalation also resolves the alert it supersedes. */
  async onRaised(
    alert: AlertRaisedV1,
    outcome: 'raised' | 'escalated',
  ): Promise<void> {
    const occurredAt = new Date(alert.occurredAt);
    await this.db.transaction(async (tx) => {
      let openedAt = occurredAt;
      if (outcome === 'escalated') {
        const superseded = await tx
          .update(events)
          .set({
            status: 'resolved',
            resolvedAt: occurredAt,
            resolution: { reason: 'escalated', supersededBy: alert.id },
          })
          .where(
            and(
              eq(events.dedupKey, alert.dedupKey),
              eq(events.status, 'open'),
              ne(events.id, alert.id),
            ),
          )
          .returning({ openedAt: events.openedAt });
        for (const row of superseded) {
          if (row.openedAt < openedAt) openedAt = row.openedAt;
        }
      }
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

  /** A de-escalation or a suppressed re-raise (which may reopen the row). */
  async onUpdated(update: AlertUpdate): Promise<void> {
    await this.db
      .update(events)
      .set({
        currentSeverity: update.alert.severity,
        lastSeenAt: update.at,
        ...(update.reopened
          ? { status: 'open' as const, resolvedAt: null, resolution: null }
          : {}),
      })
      .where(eq(events.id, update.alert.alertId));
  }

  /** Marks the open row of the occurrence resolved (no-op when already resolved). */
  async onResolved(resolution: AlertResolution): Promise<void> {
    await this.db
      .update(events)
      .set({
        status: 'resolved',
        resolvedAt: resolution.resolvedAt,
        lastSeenAt: resolution.resolvedAt,
        resolution: { ...resolution.data, reason: resolution.reason ?? null },
      })
      .where(
        and(eq(events.id, resolution.alert.alertId), eq(events.status, 'open')),
      );
  }

  /** Open occurrences with their owning detector, restored at startup so a restart does not re-raise them. */
  async loadOpen(): Promise<readonly OpenAlert[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(eq(events.status, 'open'));
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
