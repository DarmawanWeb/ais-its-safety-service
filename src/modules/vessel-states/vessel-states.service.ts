import { NotFoundError } from '@darmawanweb/ais-its-nest';
import { bboxOf } from '@darmawanweb/ais-its-nest/http';
import { Injectable } from '@nestjs/common';

import {
  type ListVesselStatesQuery,
  VESSEL_STATES_DEFAULT_SINCE_MS,
} from './dto/list-vessel-states.query.js';
import type { VesselStateRecord } from './vessel-state.js';
import { VesselStatesRepository } from './vessel-states.repository.js';

/** Error code of an unknown vessel safety state. */
export const SAFETY_STATE_NOT_FOUND = 'SAFETY_STATE_NOT_FOUND';

/**
 * Read side of the vessel safety states. Navigational safety is shared
 * across tenants (spec §8.5): every principal with `safety:read` sees every
 * vessel's state.
 */
@Injectable()
export class VesselStatesService {
  constructor(private readonly states: VesselStatesRepository) {}

  /** Latest states matching the query. */
  list(
    query: ListVesselStatesQuery,
    now: Date = new Date(),
  ): Promise<VesselStateRecord[]> {
    return this.states.list({
      bbox: bboxOf(query),
      ewsStatuses: query.ewsStatus,
      collisionRisks: query.collisionRisk,
      since:
        query.since === undefined
          ? new Date(now.getTime() - VESSEL_STATES_DEFAULT_SINCE_MS)
          : new Date(query.since),
      limit: query.limit,
    });
  }

  /**
   * The state of one vessel.
   *
   * @throws {NotFoundError} `SAFETY_STATE_NOT_FOUND` when the vessel has none.
   */
  async get(mmsi: number): Promise<VesselStateRecord> {
    const state = await this.states.get(mmsi);
    if (state === undefined) {
      throw new NotFoundError(`No safety state for MMSI ${mmsi}`, {
        code: SAFETY_STATE_NOT_FOUND,
        title: 'Safety state not found',
        extra: { mmsi },
      });
    }
    return state;
  }
}
