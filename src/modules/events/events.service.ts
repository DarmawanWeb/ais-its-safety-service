import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import type { Principal } from '@darmawanweb/ais-its-contracts/auth';
import { NotFoundError } from '@darmawanweb/ais-its-nest';
import {
  bboxOf,
  cursorPage,
  decodeQueryCursor,
  resolveQueryTimeRange,
} from '@darmawanweb/ais-its-nest/http';
import { Injectable } from '@nestjs/common';
import * as z from 'zod';

import { safetyReadScope } from '../../common/tenancy.js';
import {
  EVENTS_DEFAULT_RANGE_MS,
  EVENTS_MAX_RANGE_MS,
  type ListEventsQuery,
} from './dto/list-events.query.js';
import { type EventRecord, EventsRepository } from './events.repository.js';

/** Keyset position of the events list (newest first). */
const EventCursorSchema = z.object({
  time: z.iso.datetime(),
  id: z.uuid(),
});

/**
 * Detector events (spec §13.7). Tenancy (spec §8.5): `authority` and
 * `super_admin` read every event; other principals the events whose `mmsi`
 * or `relatedMmsi` is a vessel of their organization.
 */
@Injectable()
export class EventsService {
  constructor(private readonly events: EventsRepository) {}

  /**
   * A page of events matching the query, newest first. `status=open`
   * without `from` lists every open occurrence, however long ago it was
   * raised (an EWS warning can last weeks); `to` then only applies when given.
   */
  async list(
    query: ListEventsQuery,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<CursorPage<EventRecord>> {
    const { from, to } =
      query.status === 'open' && query.from === undefined
        ? {
            from: undefined,
            to: query.to === undefined ? undefined : new Date(query.to),
          }
        : resolveQueryTimeRange(query, {
            defaultDurationMs: EVENTS_DEFAULT_RANGE_MS,
            maxDurationMs: EVENTS_MAX_RANGE_MS,
            now,
          });
    const after = decodeQueryCursor(query, EventCursorSchema);
    const rows = await this.events.list(
      {
        from,
        to,
        detector: query.detector,
        severity: query.severity,
        status: query.status,
        mmsi: query.mmsi,
        bbox: bboxOf(query),
        after:
          after === undefined
            ? undefined
            : { id: after.id, time: new Date(after.time) },
        limit: query.limit + 1,
      },
      safetyReadScope(principal),
    );
    return cursorPage(rows, query.limit, (row) => ({
      time: row.time.toISOString(),
      id: row.id,
    }));
  }

  /**
   * One event the principal may read.
   *
   * @throws {NotFoundError} `SAFETY_EVENT_NOT_FOUND` when it does not exist or
   *   is outside the principal's tenancy (no existence leak).
   */
  async get(id: string, principal: Principal): Promise<EventRecord> {
    const event = await this.events.get(id, safetyReadScope(principal));
    if (event === undefined) {
      throw new NotFoundError(`No safety event ${id}`, {
        code: 'SAFETY_EVENT_NOT_FOUND',
        extra: { id },
      });
    }
    return event;
  }
}
