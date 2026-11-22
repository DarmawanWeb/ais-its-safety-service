import {
  COG_NOT_AVAILABLE,
  SOG_NOT_AVAILABLE,
} from '@darmawanweb/ais-its-contracts/domain';

/**
 * Nautical miles per degree of latitude: 1 nm = 1 arc-minute.
 *
 * @see williams-aviation-formulary (methods.json `collision.cpa_tcpa`, constant k_arcmin)
 */
export const NM_PER_DEGREE = 60;

/** Metres per international nautical mile. */
export const METERS_PER_NM = 1852;

/**
 * Relative speeds below this value (knots) count as "no relative motion":
 * the range stays constant, so the CPA is the present range and the TCPA is
 * undefined (methods.json `collision.cpa_tcpa`, variable CPA/TCPA).
 */
export const MIN_RELATIVE_SPEED_KN = 1e-6;

/** A vessel's position and constant motion, the inputs of the CPA/TCPA method. */
export interface MotionState {
  /** Latitude, degrees (WGS 84). */
  readonly lat: number;
  /** Longitude, degrees (WGS 84). */
  readonly lon: number;
  /** Speed over ground, knots. */
  readonly sogKn: number;
  /** Course over ground, degrees true. */
  readonly cogDeg: number;
}

/** A plane vector: east (`x`) and north (`y`) components. */
export interface PlaneVector {
  readonly x: number;
  readonly y: number;
}

/** Result of {@link computeCpaTcpa}. */
export interface CpaTcpa {
  /** Distance at the closest point of approach, nautical miles. */
  readonly cpaNm: number;
  /**
   * Time to the closest point of approach, minutes; negative when the
   * closest point lies in the past (the vessels diverge), `null` without
   * relative motion.
   */
  readonly tcpaMin: number | null;
  /** Present range between the vessels, nautical miles. */
  readonly rangeNm: number;
  /** Speed of the target relative to own vessel, knots. */
  readonly relativeSpeedKn: number;
}

/** `true` when an AIS speed over ground is a usable value (not `102.3` = not available). */
export function isSogAvailable(sogKn: number): boolean {
  return Number.isFinite(sogKn) && sogKn >= 0 && sogKn < SOG_NOT_AVAILABLE;
}

/** `true` when an AIS course over ground is a usable value (not `360` = not available). */
export function isCogAvailable(cogDeg: number): boolean {
  return Number.isFinite(cogDeg) && cogDeg >= 0 && cogDeg < COG_NOT_AVAILABLE;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Longitude difference `to - from` folded into [-180, 180) degrees. */
function longitudeDelta(from: number, to: number): number {
  return ((((to - from + 180) % 360) + 360) % 360) - 180;
}

/**
 * Velocity of a vessel on the local plane: `v = SOG (sin COG, cos COG)`.
 *
 * @method collision.cpa_tcpa
 * @param sogKn speed over ground, knots.
 * @param cogDeg course over ground, degrees true.
 * @returns east and north components, knots.
 * @see docs/METHODOLOGY.md §6.1 (`collision.cpa_tcpa`)
 */
export function velocityKn(sogKn: number, cogDeg: number): PlaneVector {
  const course = toRadians(cogDeg);
  return { x: sogKn * Math.sin(course), y: sogKn * Math.cos(course) };
}

/**
 * Position of `target` relative to `own` on an equirectangular plane around
 * own vessel: `Δx = 60 (λj − λi) cos φi`, `Δy = 60 (φj − φi)` (adequate for
 * the few nautical miles of a collision search).
 *
 * @method collision.cpa_tcpa
 * @returns east and north offsets, nautical miles.
 * @see docs/METHODOLOGY.md §6.1 (`collision.cpa_tcpa`)
 * @see lenart-2015-collision-threat
 */
export function relativePositionNm(
  own: Pick<MotionState, 'lat' | 'lon'>,
  target: Pick<MotionState, 'lat' | 'lon'>,
): PlaneVector {
  return {
    x:
      NM_PER_DEGREE *
      longitudeDelta(own.lon, target.lon) *
      Math.cos(toRadians(own.lat)),
    y: NM_PER_DEGREE * (target.lat - own.lat),
  };
}

/**
 * Closest point of approach between two vessels from their relative motion,
 * assuming constant SOG and COG (the classic radar/ARPA plotting
 * formulation, derived for AIS data by Lenart 2015):
 *
 * - relative position `Δp = (Δx, Δy)` (nm) and velocity `Δv = v_j − v_i` (kn),
 * - `TCPA = −60 (Δp · Δv) / |Δv|²` minutes,
 * - `CPA = |Δx Δv_y − Δy Δv_x| / |Δv|` nautical miles,
 * - without relative motion (`|Δv|` below {@link MIN_RELATIVE_SPEED_KN})
 *   the range never changes: `CPA` = present range, `TCPA` undefined.
 *
 * Callers align both positions to one time first ({@link deadReckon}).
 *
 * @method collision.cpa_tcpa
 * @param own vessel i (the origin of the plane).
 * @param target vessel j.
 * @see docs/METHODOLOGY.md §6.1 (`collision.cpa_tcpa`)
 * @see lenart-2015-collision-threat, bole-wall-norris-2014-radar-arpa, imo-msc-192-79
 */
export function computeCpaTcpa(own: MotionState, target: MotionState): CpaTcpa {
  const position = relativePositionNm(own, target);
  const ownVelocity = velocityKn(own.sogKn, own.cogDeg);
  const targetVelocity = velocityKn(target.sogKn, target.cogDeg);
  const velocity = {
    x: targetVelocity.x - ownVelocity.x,
    y: targetVelocity.y - ownVelocity.y,
  };
  const rangeNm = Math.hypot(position.x, position.y);
  const relativeSpeedKn = Math.hypot(velocity.x, velocity.y);
  if (relativeSpeedKn < MIN_RELATIVE_SPEED_KN) {
    return { cpaNm: rangeNm, tcpaMin: null, rangeNm, relativeSpeedKn };
  }
  const dot = position.x * velocity.x + position.y * velocity.y;
  const tcpaHours = -dot / (relativeSpeedKn * relativeSpeedKn);
  const cpaNm =
    Math.abs(position.x * velocity.y - position.y * velocity.x) /
    relativeSpeedKn;
  return { cpaNm, tcpaMin: tcpaHours * 60, rangeNm, relativeSpeedKn };
}

/**
 * Dead reckoning on the same local plane: the position after `minutes` on
 * constant SOG/COG (negative `minutes` go back in time). Aligns the latest
 * reports of two vessels to one instant before {@link computeCpaTcpa}, under
 * the method's constant-motion assumption.
 *
 * @method collision.cpa_tcpa
 * @param state position, SOG (kn) and COG (deg).
 * @param minutes time to move, minutes.
 * @returns the propagated latitude and longitude, degrees.
 * @see docs/METHODOLOGY.md §6.1 (`collision.cpa_tcpa`, assumptions)
 */
export function deadReckon(
  state: MotionState,
  minutes: number,
): Pick<MotionState, 'lat' | 'lon'> {
  if (minutes === 0) return { lat: state.lat, lon: state.lon };
  const velocity = velocityKn(state.sogKn, state.cogDeg);
  const hours = minutes / 60;
  const lat = state.lat + (velocity.y * hours) / NM_PER_DEGREE;
  const lon =
    state.lon +
    (velocity.x * hours) / (NM_PER_DEGREE * Math.cos(toRadians(state.lat)));
  return { lat, lon: longitudeDelta(0, lon) };
}

/** A vessel report: position, motion and the time it was taken. */
export interface TimedMotionState extends MotionState {
  readonly time: Date;
}

/** Predicted positions of both vessels of a pair at their closest point of approach. */
export interface CpaPositions {
  readonly a: Pick<MotionState, 'lat' | 'lon'>;
  readonly b: Pick<MotionState, 'lat' | 'lon'>;
}

/**
 * Where the two vessels are predicted at their closest point of approach:
 * each report dead-reckoned on constant SOG/COG ({@link deadReckon}) from
 * its own time to `at + tcpaMin`, where `at` is the instant the CPA/TCPA
 * was computed for (the evaluating vessel's report; the other report is
 * aligned to it). `undefined` without relative motion (`tcpaMin` `null`),
 * for a closest point in the past (`tcpaMin < 0`, diverging) or when a
 * report has no usable SOG/COG.
 *
 * @method collision.cpa_tcpa
 * @see docs/METHODOLOGY.md §6.1 (`collision.cpa_tcpa`, assumptions)
 */
export function predictedCpaPositions(
  a: TimedMotionState,
  b: TimedMotionState,
  at: Date,
  tcpaMin: number | null,
): CpaPositions | undefined {
  if (tcpaMin === null || !Number.isFinite(tcpaMin) || tcpaMin < 0)
    return undefined;
  for (const report of [a, b])
    if (!isSogAvailable(report.sogKn) || !isCogAvailable(report.cogDeg))
      return undefined;
  const cpaTime = at.getTime() + tcpaMin * 60_000;
  const at_ = (report: TimedMotionState) =>
    deadReckon(report, (cpaTime - report.time.getTime()) / 60_000);
  return { a: at_(a), b: at_(b) };
}
