import * as z from 'zod';

import {
  type CollisionRiskBands,
  DEFAULT_COLLISION_RISK_BANDS,
  DEFAULT_RISK_HYSTERESIS,
} from '../../domain/collision-risk.js';

const { high, medium, low } = DEFAULT_COLLISION_RISK_BANDS;

/** Longest candidate window (`COLLISION_MAX_AGE_S`): the runner's pair index keeps 10 minutes. */
export const COLLISION_MAX_AGE_LIMIT_S = 600;

/**
 * `COLLISION_*` variables (prefix removed by the SDK). Every value is a v2
 * design default that needs domain validation (spec §13.7, methods.json
 * `collision.cpa_tcpa`); the band limits must grow from high to low.
 *
 * @see docs/METHODOLOGY.md §6.1 (`collision.cpa_tcpa`, constants)
 */
export const collisionConfigSchema = z
  .object({
    /** Candidate search radius around a moving vessel, nm (R_search). */
    // SOURCE: thesis — needs citation (v2 design default)
    SEARCH_RADIUS_NM: z.coerce.number().positive().max(50).default(6),
    /** Candidates must have been seen within this window of the position, s (t_seen). */
    // SOURCE: thesis — needs citation (v2 design default)
    MAX_AGE_S: z.coerce
      .number()
      .int()
      .positive()
      .max(COLLISION_MAX_AGE_LIMIT_S)
      .default(120),
    /** Vessels slower than this are not assessed, knots (SOG_min). */
    // SOURCE: thesis — needs citation (v2 design default)
    MIN_SOG_KN: z.coerce.number().nonnegative().default(0.5),
    HIGH_CPA_NM: z.coerce.number().positive().default(high.cpaNm),
    HIGH_TCPA_MIN: z.coerce.number().positive().default(high.tcpaMin),
    MEDIUM_CPA_NM: z.coerce.number().positive().default(medium.cpaNm),
    MEDIUM_TCPA_MIN: z.coerce.number().positive().default(medium.tcpaMin),
    LOW_CPA_NM: z.coerce.number().positive().default(low.cpaNm),
    LOW_TCPA_MIN: z.coerce.number().positive().default(low.tcpaMin),
    /** Widening of a band's limits before a pair falls out of it, fraction. */
    HYSTERESIS: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(DEFAULT_RISK_HYSTERESIS),
    /** Minimum interval between two stored samples of an unchanged encounter, s (0 = every evaluation). */
    SAMPLE_INTERVAL_S: z.coerce.number().int().min(0).max(3600).default(30),
  })
  .refine(
    (c) => c.HIGH_CPA_NM <= c.MEDIUM_CPA_NM && c.MEDIUM_CPA_NM <= c.LOW_CPA_NM,
    {
      message:
        'COLLISION_HIGH_CPA_NM ≤ COLLISION_MEDIUM_CPA_NM ≤ COLLISION_LOW_CPA_NM',
      path: ['MEDIUM_CPA_NM'],
    },
  )
  .refine(
    (c) =>
      c.HIGH_TCPA_MIN <= c.MEDIUM_TCPA_MIN &&
      c.MEDIUM_TCPA_MIN <= c.LOW_TCPA_MIN,
    {
      message:
        'COLLISION_HIGH_TCPA_MIN ≤ COLLISION_MEDIUM_TCPA_MIN ≤ COLLISION_LOW_TCPA_MIN',
      path: ['MEDIUM_TCPA_MIN'],
    },
  );

/** Parsed `COLLISION_*` configuration. */
export type CollisionConfig = z.output<typeof collisionConfigSchema>;

/** The risk bands of a configuration. */
export function collisionBands(config: CollisionConfig): CollisionRiskBands {
  return {
    high: { cpaNm: config.HIGH_CPA_NM, tcpaMin: config.HIGH_TCPA_MIN },
    medium: { cpaNm: config.MEDIUM_CPA_NM, tcpaMin: config.MEDIUM_TCPA_MIN },
    low: { cpaNm: config.LOW_CPA_NM, tcpaMin: config.LOW_TCPA_MIN },
  };
}
