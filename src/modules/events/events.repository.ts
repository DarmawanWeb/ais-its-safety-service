import type {
  AlertSeverity,
  BBox,
  SafetyEventStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  type Database,
  geographyIntersectsBBox,
  InjectDb,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lt, or, type SQL, sql } from 'drizzle-orm';

import { scopeCondition } from '../../common/tenancy.sql.js';
import type { SafetyReadScope } from '../../common/tenancy.js';
import * as schema from '../../db/schema.js';

const { events } = schema;

/** Filters of `GET /safety/events`. */
export interface EventFilter {
  readonly from: Date;
  readonly to: Date;
  readonly detector?: string | undefined;
  readonly severity?: AlertSeverity | undefined;
  readonly status?: SafetyEventStatus | undefined;
  /** As `mmsi` or `relatedMmsi`. */
  readonly mmsi?: number | undefined;
  readonly bbox?: BBox | undefined;
  /** Keyset position after which to continue (newest first). */
  readonly after?: { readonly time: Date; readonly id: string } | undefined;
  readonly limit: number;
}

/** A stored event with its coordinates. */
export type EventRecord = Omit<typeof events.$inferSelect, 'geom'> & {
  readonly lat: number | null;
  readonly lon: number | null;
};

/** Read side of the `events` hypertable (the AlertPersistence hook writes it). */
@Injectable()
export class EventsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** Events matching `filter` that `scope` may read, newest first. */
  async list(
    filter: EventFilter,
    scope: SafetyReadScope,
  ): Promise<EventRecord[]> {
    const conditions: (SQL | undefined)[] = [
      gte(events.time, filter.from),
      lt(events.time, filter.to),
      scopeCondition(scope, [events.mmsi, events.relatedMmsi]),
    ];
    if (filter.detector !== undefined)
      conditions.push(eq(events.detector, filter.detector));
    if (filter.severity !== undefined)
      conditions.push(eq(events.severity, filter.severity));
    if (filter.status !== undefined)
      conditions.push(eq(events.status, filter.status));
    if (filter.mmsi !== undefined)
      conditions.push(
        or(eq(events.mmsi, filter.mmsi), eq(events.relatedMmsi, filter.mmsi)),
      );
    if (filter.bbox !== undefined)
      conditions.push(geographyIntersectsBBox(events.geom, filter.bbox));
    if (filter.after !== undefined)
      conditions.push(
        sql`(${events.time}, ${events.id}) < (${filter.after.time}, ${filter.after.id})`,
      );
    return this.selectEvents()
      .where(and(...conditions))
      .orderBy(desc(events.time), desc(events.id))
      .limit(filter.limit);
  }

  /** One event that `scope` may read. */
  async get(
    id: string,
    scope: SafetyReadScope,
  ): Promise<EventRecord | undefined> {
    const [row] = await this.selectEvents()
      .where(
        and(
          eq(events.id, id),
          scopeCondition(scope, [events.mmsi, events.relatedMmsi]),
        ),
      )
      .limit(1);
    return row;
  }

  private selectEvents() {
    return this.db
      .select({
        id: events.id,
        time: events.time,
        detector: events.detector,
        type: events.type,
        domain: events.domain,
        severity: events.severity,
        currentSeverity: events.currentSeverity,
        mmsi: events.mmsi,
        relatedMmsi: events.relatedMmsi,
        zoneId: events.zoneId,
        lat: sql<number | null>`ST_Y(${events.geom}::geometry)`,
        lon: sql<number | null>`ST_X(${events.geom}::geometry)`,
        title: events.title,
        message: events.message,
        methodId: events.methodId,
        dedupKey: events.dedupKey,
        data: events.data,
        status: events.status,
        openedAt: events.openedAt,
        lastSeenAt: events.lastSeenAt,
        resolvedAt: events.resolvedAt,
        resolution: events.resolution,
        createdAt: events.createdAt,
      })
      .from(events)
      .$dynamic();
  }
}
