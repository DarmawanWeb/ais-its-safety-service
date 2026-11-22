import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import type { Principal } from '@darmawanweb/ais-its-contracts/auth';
import {
  cursorPage,
  decodeQueryCursor,
  resolveQueryTimeRange,
} from '@darmawanweb/ais-its-nest/http';
import { Injectable } from '@nestjs/common';
import * as z from 'zod';

import { safetyReadScope } from '../../common/tenancy.js';
import {
  ENCOUNTERS_DEFAULT_RANGE_MS,
  ENCOUNTERS_MAX_RANGE_MS,
  type ListEncountersQuery,
} from './dto/list-encounters.query.js';
import type { EncounterRecord } from './encounter.js';
import { EncountersRepository } from './encounters.repository.js';

/**
 * Cursor of the encounters list: the last encounter returned and the time
 * window of the first page, so that every page reads the same window (`to`
 * defaults to the request time and would otherwise move between pages).
 */
const EncounterCursorSchema = z.object({
  encounterId: z.uuid(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
});

/**
 * Collision encounter history. Encounters are safety events of two vessels
 * (spec §8.5): `authority` / `super_admin` read all of them, other
 * principals those where one vessel belongs to their organization.
 */
@Injectable()
export class EncountersService {
  constructor(private readonly encounters: EncountersRepository) {}

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
    const rows = await this.encounters.list(
      {
        from,
        to,
        peakRisks: query.risk,
        mmsi: query.mmsi,
        encounterId: query.encounterId,
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
    }));
  }
}
