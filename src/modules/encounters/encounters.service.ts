import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import type { Principal } from '@darmawanweb/ais-its-contracts/auth';
import { DETECTOR_ENV, detectorEnv } from '@darmawanweb/ais-its-nest/analytics';
import {
  bboxOf,
  cursorPage,
  decodeQueryCursor,
  resolveQueryTimeRange,
} from '@darmawanweb/ais-its-nest/http';
import { Inject, Injectable } from '@nestjs/common';
import * as z from 'zod';

import { safetyReadScope } from '../../common/tenancy.js';
import { collisionConfigSchema } from '../../detectors/collision/collision.config.js';
import {
  ENCOUNTERS_DEFAULT_RANGE_MS,
  ENCOUNTERS_MAX_RANGE_MS,
  type ListEncountersQuery,
} from './dto/list-encounters.query.js';
import { activeEncounterWindowMs, type EncounterRecord } from './encounter.js';
import { EncountersRepository } from './encounters.repository.js';

/**
 * Cursor of the encounters list: the last encounter returned and the time
 * window of the first page (and its `active` cut-off), so that every page
 * reads the same window (`to` defaults to the request time and the event
 * clock moves on, both would otherwise move between pages).
 */
const EncounterCursorSchema = z.object({
  encounterId: z.uuid(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  activeSince: z.iso.datetime().optional(),
});

/**
 * Collision encounter history. Encounters are safety events of two vessels
 * (spec §8.5): `authority` / `super_admin` read all of them, other
 * principals those where one vessel belongs to their organization.
 */
@Injectable()
export class EncountersService {
  /** How long after its latest sample an encounter counts as active, ms of event time. */
  readonly activeWindowMs: number;

  constructor(
    private readonly encounters: EncountersRepository,
    @Inject(DETECTOR_ENV) env: Readonly<Record<string, string | undefined>>,
  ) {
    // The collision detector's own window (`COLLISION_*` of this instance);
    // its defaults when the variables are invalid (the runner refuses to
    // start with them only where the detector is enabled).
    const parsed = collisionConfigSchema.safeParse(
      detectorEnv('collision', env),
    );
    this.activeWindowMs = activeEncounterWindowMs(
      parsed.success ? parsed.data : collisionConfigSchema.parse({}),
    );
  }

  /**
   * A page of encounters with samples in the query's range, newest
   * encounter first. With a cursor, the window is the one of the first page.
   */
  async list(
    query: ListEncountersQuery,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<CursorPage<EncounterRecord>> {
    const after = decodeQueryCursor(query, EncounterCursorSchema);
    const { from, to } =
      after === undefined
        ? resolveQueryTimeRange(query, {
            defaultDurationMs: ENCOUNTERS_DEFAULT_RANGE_MS,
            maxDurationMs: ENCOUNTERS_MAX_RANGE_MS,
            now,
          })
        : { from: new Date(after.from), to: new Date(after.to) };
    const activeSince =
      query.active === undefined
        ? undefined
        : after?.activeSince === undefined
          ? await this.activeCutoff(now)
          : new Date(after.activeSince);
    const rows = await this.encounters.list(
      {
        from,
        to,
        peakRisks: query.risk,
        mmsi: query.mmsi,
        encounterId: query.encounterId,
        bbox: bboxOf(query),
        activity:
          query.active === undefined || activeSince === undefined
            ? undefined
            : { active: query.active, since: activeSince },
        after:
          after === undefined ? undefined : { encounterId: after.encounterId },
        limit: query.limit + 1,
      },
      safetyReadScope(principal),
    );
    return cursorPage(rows, query.limit, (row) => ({
      encounterId: row.encounterId,
      from: from.toISOString(),
      to: to.toISOString(),
      ...(activeSince === undefined
        ? {}
        : { activeSince: activeSince.toISOString() }),
    }));
  }

  /**
   * The cut-off of `active`: {@link activeWindowMs} before the collision
   * detector's event clock (the AIS time of its newest evaluation,
   * {@link EncountersRepository.collisionClock}). Samples carry AIS time,
   * which lags the request time (position time stamps, pipeline latency, a
   * backlog after an outage), and the detector closes stale pairs in that
   * time too. The clock never runs ahead of the request time (a report with
   * a future time stamp) and falls back to it before the first evaluation.
   */
  private async activeCutoff(now: Date): Promise<Date> {
    const clock = await this.encounters.collisionClock();
    const reference =
      clock === undefined || clock.getTime() > now.getTime() ? now : clock;
    return new Date(reference.getTime() - this.activeWindowMs);
  }
}
