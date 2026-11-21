import {
  type CollisionRisk,
  compareCollisionRisk,
  NAV_STATUS,
  PREDICTED_NAV_STATUS,
} from '@darmawanweb/ais-its-contracts/domain';

import { isCogAvailable, isSogAvailable } from './cpa.js';

/** Upper limits of one collision risk band: `CPA < cpaNm` and `0 ≤ TCPA < tcpaMin`. */
export interface RiskBandLimits {
  /** CPA limit, nautical miles (exclusive). */
  readonly cpaNm: number;
  /** TCPA limit, minutes (exclusive). */
  readonly tcpaMin: number;
}

/** The three alerting/reporting bands of the collision detector. */
export interface CollisionRiskBands {
  readonly high: RiskBandLimits;
  readonly medium: RiskBandLimits;
  readonly low: RiskBandLimits;
}

/**
 * Default risk bands (spec §13.7): high CPA < 0.25 nm and 0 ≤ TCPA < 6 min,
 * medium CPA < 0.5 nm and TCPA < 12 min, low CPA < 1 nm and TCPA < 20 min.
 * Design defaults of v2 that need domain validation.
 */
// SOURCE: thesis — needs citation (v2 design defaults, methods.json collision.cpa_tcpa needsCitation)
export const DEFAULT_COLLISION_RISK_BANDS: CollisionRiskBands = {
  high: { cpaNm: 0.25, tcpaMin: 6 },
  medium: { cpaNm: 0.5, tcpaMin: 12 },
  low: { cpaNm: 1, tcpaMin: 20 },
};

/**
 * Default hysteresis: a pair keeps its band until its CPA or TCPA exceeds
 * the band's limits widened by 20 %. Design default of v2.
 */
// SOURCE: thesis — needs citation (v2 design default, methods.json collision.cpa_tcpa needsCitation)
export const DEFAULT_RISK_HYSTERESIS = 0.2;

/** A CPA/TCPA measurement of a pair. */
export interface RiskMeasurement {
  /** Nautical miles. */
  readonly cpaNm: number;
  /** Minutes; `null` without relative motion. */
  readonly tcpaMin: number | null;
}

/** Bands from the highest to the lowest. */
const BANDS_DESCENDING = ['high', 'medium', 'low'] as const;

function withinLimits(
  measurement: RiskMeasurement,
  limits: RiskBandLimits,
  widening: number,
): boolean {
  const { cpaNm, tcpaMin } = measurement;
  return (
    tcpaMin !== null &&
    tcpaMin >= 0 &&
    cpaNm < limits.cpaNm * (1 + widening) &&
    tcpaMin < limits.tcpaMin * (1 + widening)
  );
}

/**
 * Risk band of a pair from its CPA and TCPA: the highest band whose limits
 * hold (`CPA < cpa limit ∧ 0 ≤ TCPA < tcpa limit`), else `none`. A negative
 * TCPA (diverging) or an undefined TCPA (no relative motion) is `none`.
 *
 * @method collision.cpa_tcpa
 * @param measurement CPA (nm) and TCPA (min).
 * @param bands band limits (`COLLISION_*` thresholds).
 * @see docs/METHODOLOGY.md §6.1 (`collision.cpa_tcpa`, risk cases)
 */
export function classifyCollisionRisk(
  measurement: RiskMeasurement,
  bands: CollisionRiskBands = DEFAULT_COLLISION_RISK_BANDS,
): CollisionRisk {
  for (const band of BANDS_DESCENDING) {
    if (withinLimits(measurement, bands[band], 0)) return band;
  }
  return 'none';
}

/**
 * Hysteresis of the risk bands: a rising band applies at once, a falling one
 * only once the pair also leaves the previous band's limits widened by
 * `hysteresis` (fraction). The pair keeps the highest band between the raw
 * band and the previous one whose widened limits still hold, so noisy
 * COG/SOG near a limit does not flap the band. Leaving the encounter
 * (diverging, no relative motion) is never delayed.
 *
 * @method collision.cpa_tcpa
 * @param raw band of the current measurement ({@link classifyCollisionRisk}).
 * @param previous band of the pair at its previous evaluation, if any.
 * @param measurement CPA (nm) and TCPA (min) of the current evaluation.
 * @param hysteresis widening of the limits when falling, fraction (0.2 = 20 %).
 * @see docs/METHODOLOGY.md §6.1 (`collision.cpa_tcpa`, hysteresis — v2 design default)
 */
export function applyRiskHysteresis(
  raw: CollisionRisk,
  previous: CollisionRisk | undefined,
  measurement: RiskMeasurement,
  bands: CollisionRiskBands = DEFAULT_COLLISION_RISK_BANDS,
  hysteresis: number = DEFAULT_RISK_HYSTERESIS,
): CollisionRisk {
  if (previous === undefined || compareCollisionRisk(raw, previous) >= 0)
    return raw;
  for (const band of BANDS_DESCENDING) {
    if (compareCollisionRisk(band, previous) > 0) continue;
    if (compareCollisionRisk(band, raw) <= 0) break;
    if (withinLimits(measurement, bands[band], hysteresis)) return band;
  }
  return raw;
}

/**
 * Band of a pair: {@link classifyCollisionRisk} followed by
 * {@link applyRiskHysteresis} against the pair's previous band.
 *
 * @method collision.cpa_tcpa
 * @see docs/METHODOLOGY.md §6.1 (`collision.cpa_tcpa`)
 */
export function assessCollisionRisk(
  measurement: RiskMeasurement,
  previous: CollisionRisk | undefined,
  bands: CollisionRiskBands = DEFAULT_COLLISION_RISK_BANDS,
  hysteresis: number = DEFAULT_RISK_HYSTERESIS,
): CollisionRisk {
  return applyRiskHysteresis(
    classifyCollisionRisk(measurement, bands),
    previous,
    measurement,
    bands,
    hysteresis,
  );
}

/** Why a vessel takes no part in collision assessment. */
export type CollisionExclusion =
  | 'predicted_at_anchor'
  | 'stationary_navstatus'
  | 'sog_unavailable'
  | 'cog_unavailable'
  | 'slow';

/** The AIS fields of a vessel the exclusion rules read. */
export interface CollisionCandidate {
  /** Reported navigational status (0–15). */
  readonly navstatus: number;
  /** `1` = predicted at anchor. */
  readonly predictedNavstatus: number;
  /** Knots (`102.3` = not available). */
  readonly sog: number;
  /** Degrees (`360` = not available). */
  readonly cog: number;
}

/** Reported navigational statuses of vessels that are not under way. */
const STATIONARY_NAV_STATUSES: ReadonlySet<number> = new Set([
  NAV_STATUS.AT_ANCHOR,
  NAV_STATUS.MOORED,
  NAV_STATUS.AGROUND,
]);

/**
 * Exclusion rules of the collision detector (spec §13.7): a vessel predicted
 * at anchor, reporting moored / at anchor / aground, without usable SOG or
 * COG (`102.3` / `360` = not available) or slower than `minSogKn` is not
 * assessed (nor is any pair it belongs to).
 *
 * @method collision.cpa_tcpa
 * @param vessel the vessel's latest AIS fields.
 * @param minSogKn minimum speed over ground, knots (`COLLISION_MIN_SOG_KN`, default 0.5).
 * @returns the reason, or `null` when the vessel takes part.
 * @see docs/METHODOLOGY.md §6.1 (`collision.cpa_tcpa`, exclusions); navstatus.ais_codes
 */
export function collisionExclusion(
  vessel: CollisionCandidate,
  minSogKn: number,
): CollisionExclusion | null {
  if (vessel.predictedNavstatus === PREDICTED_NAV_STATUS.AT_ANCHOR)
    return 'predicted_at_anchor';
  if (STATIONARY_NAV_STATUSES.has(vessel.navstatus))
    return 'stationary_navstatus';
  if (!isSogAvailable(vessel.sog)) return 'sog_unavailable';
  if (!isCogAvailable(vessel.cog)) return 'cog_unavailable';
  // SOURCE: thesis — needs citation (SOG_min = 0.5 kn is a v2 design default)
  if (vessel.sog < minSogKn) return 'slow';
  return null;
}

/** Alert key of a pair (spec §13.7): `collision:<minMmsi>:<maxMmsi>`. */
export function collisionDedupKey(mmsi: number, otherMmsi: number): string {
  return `collision:${Math.min(mmsi, otherMmsi)}:${Math.max(mmsi, otherMmsi)}`;
}
