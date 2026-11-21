import type {
  CollisionRisk,
  EwsStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import type {
  ClosestEncounter,
  SafetyVesselStateV1,
} from '@darmawanweb/ais-its-contracts/events';

import { EWS_METHOD_ID } from './ews.js';

/** Methodology catalog id of the collision risk method. */
export const COLLISION_METHOD_ID = 'collision.cpa_tcpa';

/** The latest kinematic report of a vessel (`vessel_state` position columns). */
export interface VesselKinematics {
  /** Time of the position. */
  readonly time: Date;
  readonly lat: number;
  readonly lon: number;
  /** Knots. */
  readonly sog: number;
  /** Degrees. */
  readonly cog: number;
  /** Degrees (`511` = not available). */
  readonly hdg: number;
  readonly navstatus: number;
  readonly predictedNavstatus: 0 | 1;
}

/** The EWS part of a vessel's safety state (written by the `ews` detector). */
export interface EwsStatePart {
  readonly ewsStatus: EwsStatus;
  readonly pipelineDistanceM: number | null;
  readonly nearestPipelineZoneId: string | null;
  /** Event time of the evaluation (newest wins). */
  readonly evaluatedAt: Date;
}

/** The collision part of a vessel's safety state (written by the `collision` detector). */
export interface CollisionStatePart {
  readonly collisionRisk: CollisionRisk;
  readonly closestEncounter: ClosestEncounter | null;
  /** Event time of the evaluation (newest wins). */
  readonly evaluatedAt: Date;
}

/**
 * What a detector reports about a vessel: its latest kinematics and the
 * part of the safety state it owns. Reports of one vessel are merged part by
 * part (the newest of each wins), so detectors deployed separately
 * (`DETECTORS`) never overwrite each other's part.
 */
export interface SafetyStateReport {
  readonly mmsi: number;
  readonly kinematics: VesselKinematics;
  readonly ews?: EwsStatePart | undefined;
  readonly collision?: CollisionStatePart | undefined;
}

function newer<Part extends { readonly evaluatedAt: Date }>(
  a: Part | undefined,
  b: Part | undefined,
): Part | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return b.evaluatedAt.getTime() >= a.evaluatedAt.getTime() ? b : a;
}

/** Merges two reports of one vessel: newest kinematics, newest EWS part, newest collision part. */
export function mergeSafetyReports(
  earlier: SafetyStateReport,
  later: SafetyStateReport,
): SafetyStateReport {
  return {
    mmsi: later.mmsi,
    kinematics:
      later.kinematics.time.getTime() >= earlier.kinematics.time.getTime()
        ? later.kinematics
        : earlier.kinematics,
    ews: newer(earlier.ews, later.ews),
    collision: newer(earlier.collision, later.collision),
  };
}

/**
 * Methodology ids behind a state (`SafetyVesselStateV1.methodIds`): the
 * methods of the parts that were evaluated.
 */
export function safetyStateMethodIds(evaluated: {
  readonly ews: boolean;
  readonly collision: boolean;
}): string[] {
  return [
    ...(evaluated.ews ? [EWS_METHOD_ID] : []),
    ...(evaluated.collision ? [COLLISION_METHOD_ID] : []),
  ];
}

/**
 * Numeric changes of an at-risk state that count as a state change (and
 * publish at once) rather than waiting for the heartbeat: the CPA/TCPA of a
 * vessel with collision risk and the pipeline distance of a vessel with an
 * EWS warning or danger. Publication tuning of v2 (not a methodology
 * threshold).
 */
export const STATE_CHANGE_TOLERANCES = {
  /** nm */
  cpaNm: 0.05,
  /** minutes */
  tcpaMin: 1,
  /** metres */
  pipelineDistanceM: 25,
} as const;

function differs(
  a: number | null,
  b: number | null,
  tolerance: number,
): boolean {
  if (a === null || b === null) return a !== b;
  return Math.abs(a - b) >= tolerance;
}

/**
 * `true` when `next` differs from the last published state in a way
 * consumers must learn now: EWS status, nearest pipeline, collision risk or
 * the vessel of the closest encounter; for a vessel at risk also a material
 * change of its CPA/TCPA or pipeline distance ({@link STATE_CHANGE_TOLERANCES}).
 */
export function isMaterialStateChange(
  published: SafetyVesselStateV1,
  next: SafetyVesselStateV1,
): boolean {
  if (
    published.ewsStatus !== next.ewsStatus ||
    published.nearestPipelineZoneId !== next.nearestPipelineZoneId ||
    published.collisionRisk !== next.collisionRisk ||
    (published.closestEncounter?.otherMmsi ?? null) !==
      (next.closestEncounter?.otherMmsi ?? null) ||
    published.methodIds.join(',') !== next.methodIds.join(',')
  ) {
    return true;
  }
  if (
    next.ewsStatus !== 3 &&
    differs(
      published.pipelineDistanceM,
      next.pipelineDistanceM,
      STATE_CHANGE_TOLERANCES.pipelineDistanceM,
    )
  ) {
    return true;
  }
  const before = published.closestEncounter;
  const after = next.closestEncounter;
  return (
    next.collisionRisk !== 'none' &&
    before !== null &&
    after !== null &&
    (differs(before.cpaNm, after.cpaNm, STATE_CHANGE_TOLERANCES.cpaNm) ||
      differs(before.tcpaMin, after.tcpaMin, STATE_CHANGE_TOLERANCES.tcpaMin))
  );
}

/** Why a state is published: first state, a change, or the heartbeat. */
export type PublicationReason = 'initial' | 'change' | 'heartbeat';

/**
 * Publication rule of the `SAFETY` stream (spec §13.7): publish a vessel's
 * state when it changed ({@link isMaterialStateChange}) and at most every
 * `heartbeatMs` (event time) otherwise.
 *
 * @param published the last published state, `null` when none was.
 * @param next the current state.
 * @param heartbeatMs `SAFETY_STATE_HEARTBEAT_S` in milliseconds.
 * @returns why to publish now, or `null` to skip.
 */
export function publicationReason(
  published: SafetyVesselStateV1 | null,
  next: SafetyVesselStateV1,
  heartbeatMs: number,
): PublicationReason | null {
  if (published === null) return 'initial';
  if (Date.parse(next.time) < Date.parse(published.time)) return null;
  if (isMaterialStateChange(published, next)) return 'change';
  return Date.parse(next.time) - Date.parse(published.time) >= heartbeatMs
    ? 'heartbeat'
    : null;
}
