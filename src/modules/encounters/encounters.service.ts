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

/** Keyset position of the encounters list (latest sample first). */
const EncounterCursorSchema = z.object({
  lastSampleAt: z.iso.datetime(),
  encounterId: z.uuid(),
});

/**
 * Collision encounter history. Encounters are safety events of two vessels
 * (spec §8.5): `authority` / `super_admin` read all of them, other
 * principals those where one vessel belongs to their organization.
 */
@Injectable()
export class EncountersService {
  constructor(private readonly encounters: EncountersRepository) {}

  /** A page of encounters with samples in the query's range, latest sample first. */
  async list(
    query: ListEncountersQuery,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<CursorPage<EncounterRecord>> {
    const { from, to } = resolveQueryTimeRange(query, {
      defaultDurationMs: ENCOUNTERS_DEFAULT_RANGE_MS,
      maxDurationMs: ENCOUNTERS_MAX_RANGE_MS,
      now,
    });
    const after = decodeQueryCursor(query, EncounterCursorSchema);
    const rows = await this.encounters.list(
      {
        from,
        to,
        peakRisks: query.risk,
        mmsi: query.mmsi,
        encounterId: query.encounterId,
        after:
          after === undefined
            ? undefined
            : {
                lastSampleAt: new Date(after.lastSampleAt),
                encounterId: after.encounterId,
              },
        limit: query.limit + 1,
      },
      safetyReadScope(principal),
    );
    return cursorPage(rows, query.limit, (row) => ({
      lastSampleAt: row.lastSampleAt.toISOString(),
      encounterId: row.encounterId,
    }));
  }
}
