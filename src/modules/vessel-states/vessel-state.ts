import type {
  BBox,
  CollisionRisk,
  EwsStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import type { ClosestEncounter } from '@darmawanweb/ais-its-contracts/events';

import type { VesselIdentity } from '../../common/vessel-identity.js';
import type { VesselKinematics } from '../../domain/safety-state.js';

/** Identity of a pipeline zone (the `zones` projection of `GEO`). */
export interface PipelineIdentity {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** The latest safety state of a vessel as the REST API returns it. */
export interface VesselStateRecord {
  readonly mmsi: number;
  /** Event time of the latest evaluation (`SafetyVesselStateV1.time`). */
  readonly evaluatedAt: Date;
  /** The vessel's latest position. */
  readonly position: VesselKinematics;
  readonly ewsStatus: EwsStatus;
  readonly pipelineDistanceM: number | null;
  readonly nearestPipelineZoneId: string | null;
  /** Code and name of that zone; `null` without one or when the projection lacks it. */
  readonly nearestPipeline: PipelineIdentity | null;
  /** Owner of the nearest pipeline zone, `null` = global (decides who sees it, spec §8.5). */
  readonly nearestPipelineOrgId: string | null;
  readonly collisionRisk: CollisionRisk;
  readonly closestEncounter: ClosestEncounter | null;
  readonly methodIds: readonly string[];
  /** Fleet identity (shared across tenants, spec §8.5); `null` for unregistered vessels. */
  readonly vessel: VesselIdentity | null;
  readonly updatedAt: Date;
}

/**
 * The vessels `GET /safety/vessels` lists and `GET /safety/stats` counts:
 * those with a position at or after `since`, in `bbox` when given.
 */
export interface VesselStateWindow {
  readonly bbox?: BBox | undefined;
  /** Only vessels with a position at or after this time. */
  readonly since: Date;
}

/** Filters of `GET /safety/vessels`. */
export interface VesselStateFilter extends VesselStateWindow {
  readonly ewsStatuses?: readonly EwsStatus[] | undefined;
  readonly collisionRisks?: readonly CollisionRisk[] | undefined;
  readonly limit: number;
}

/** Vessels per alerting EWS status and collision band (`VesselStatesRepository.countAtRisk`). */
export interface AtRiskCounts {
  readonly ews: { readonly danger: number; readonly warning: number };
  readonly collision: { readonly high: number; readonly medium: number };
}

/** `GET /safety/stats`: the counts of a window and when they were taken. */
export interface SafetyStatsRecord extends AtRiskCounts {
  /** Lower bound of the position time of the counted vessels. */
  readonly since: Date;
  /** When the counts were taken. */
  readonly at: Date;
}
