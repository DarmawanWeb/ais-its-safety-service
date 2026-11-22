import type { Principal } from '@darmawanweb/ais-its-contracts/auth';
import { NotFoundError } from '@darmawanweb/ais-its-nest';
import { bboxOf } from '@darmawanweb/ais-its-nest/http';
import { Injectable } from '@nestjs/common';

import {
  canSeePipeline,
  type SafetyReadScope,
  safetyReadScope,
} from '../../common/tenancy.js';
import { hidePipeline } from '../../domain/safety-state.js';
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
 * vessel's state, except the identity and distance of an org-owned pipeline
 * zone, which only that organization and `authority` / `super_admin` see
 * (`null` for everyone else; the EWS status stays shared).
 */
@Injectable()
export class VesselStatesService {
  constructor(private readonly states: VesselStatesRepository) {}

  /** Latest states matching the query, as `principal` may see them. */
  async list(
    query: ListVesselStatesQuery,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<VesselStateRecord[]> {
    const scope = safetyReadScope(principal);
    const states = await this.states.list({
      bbox: bboxOf(query),
      ewsStatuses: query.ewsStatus,
      collisionRisks: query.collisionRisk,
      since:
        query.since === undefined
          ? new Date(now.getTime() - VESSEL_STATES_DEFAULT_SINCE_MS)
          : new Date(query.since),
      limit: query.limit,
    });
    return states.map((state) => visibleTo(scope, state));
  }

  /**
   * The state of one vessel, as `principal` may see it.
   *
   * @throws {NotFoundError} `SAFETY_STATE_NOT_FOUND` when the vessel has none.
   */
  async get(mmsi: number, principal: Principal): Promise<VesselStateRecord> {
    const state = await this.states.get(mmsi);
    if (state === undefined) {
      throw new NotFoundError(`No safety state for MMSI ${mmsi}`, {
        code: SAFETY_STATE_NOT_FOUND,
        title: 'Safety state not found',
        extra: { mmsi },
      });
    }
    return visibleTo(safetyReadScope(principal), state);
  }
}

/** The state without an org-owned pipeline the reader may not see. */
function visibleTo(
  scope: SafetyReadScope,
  state: VesselStateRecord,
): VesselStateRecord {
  return canSeePipeline(scope, state.nearestPipelineOrgId)
    ? state
    : hidePipeline(state);
}
