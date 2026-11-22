import type {
  BBox,
  CollisionRisk,
  EwsStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import type { ClosestEncounter } from '@darmawanweb/ais-its-contracts/events';

import type { VesselKinematics } from '../../domain/safety-state.js';

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
  /** Owner of the nearest pipeline zone, `null` = global (decides who sees it, spec §8.5). */
  readonly nearestPipelineOrgId: string | null;
  readonly collisionRisk: CollisionRisk;
  readonly closestEncounter: ClosestEncounter | null;
  readonly methodIds: readonly string[];
  /** Fleet identity (shared across tenants, spec §8.5); `null` for unregistered vessels. */
  readonly vessel: { readonly id: string; readonly name: string } | null;
  readonly updatedAt: Date;
}

/** Filters of `GET /safety/vessels`. */
export interface VesselStateFilter {
  readonly bbox?: BBox | undefined;
  readonly ewsStatuses?: readonly EwsStatus[] | undefined;
  readonly collisionRisks?: readonly CollisionRisk[] | undefined;
  /** Only vessels with a position at or after this time. */
  readonly since: Date;
  readonly limit: number;
}
