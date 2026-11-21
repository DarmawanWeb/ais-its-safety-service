import {
  EWS_DANGER_DISTANCE_M,
  EWS_WARNING_DISTANCE_M,
  type EwsThresholds,
} from '@darmawanweb/ais-its-contracts/domain';
import * as z from 'zod';

/**
 * `EWS_*` variables (prefix removed by the SDK): the legacy thresholds of
 * `checkShipStatus`, in metres. `EWS_DANGER_M` must stay below
 * `EWS_WARNING_M`.
 *
 * @see docs/METHODOLOGY.md §5.1 (`ews.pipeline_distance_status`, constants d_danger, d_warning)
 */
export const ewsConfigSchema = z
  .object({
    /** Danger distance (prohibited zone), m. Legacy 500. */
    DANGER_M: z.coerce.number().positive().default(EWS_DANGER_DISTANCE_M),
    /** Warning distance (500 + 1 250 m restricted zone), m. Legacy 1 750. */
    WARNING_M: z.coerce.number().positive().default(EWS_WARNING_DISTANCE_M),
  })
  .refine((config) => config.DANGER_M < config.WARNING_M, {
    message: 'EWS_DANGER_M must be below EWS_WARNING_M',
    path: ['DANGER_M'],
  });

/** Parsed `EWS_*` configuration. */
export type EwsConfig = z.output<typeof ewsConfigSchema>;

/** The contracts thresholds of a configuration. */
export function ewsThresholds(config: EwsConfig): EwsThresholds {
  return { dangerM: config.DANGER_M, warningM: config.WARNING_M };
}
