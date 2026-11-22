import {
  type AppConfig,
  defineConfig,
  envInteger,
  ServiceNameSchema,
  SqlIdentifierSchema,
} from '@darmawanweb/ais-its-nest';
import { DEFAULT_PINNED_TTL_MS } from '@darmawanweb/ais-its-nest/nats';
import * as z from 'zod';

import { SERVICE } from './service.js';

/**
 * Environment of the service: the platform base variables (spec §4) with this
 * service's defaults, plus its own variables. Add a variable here and to
 * `.env.example`; `loadConfig()` refuses to start on invalid values and prints
 * every problem.
 *
 * `DETECTORS` and the detector thresholds (`EWS_*`, `COLLISION_*`) are not
 * part of this schema: the Detector SDK reads and validates them with each
 * detector's own `configSchema` (spec §18), see `src/detectors/<id>/`.
 */
export const configSchema = defineConfig({
  SERVICE_NAME: ServiceNameSchema.default(SERVICE.name),
  SERVICE_VERSION: z.string().min(1).default(SERVICE.version),
  PORT: envInteger(0, 65_535).default(SERVICE.port),
  DATABASE_SCHEMA: SqlIdentifierSchema.default(SERVICE.schema),
  /**
   * Longest interval between two `safety.vessel_state.updated.v1` of a vessel
   * whose state did not change (spec §13.7), in seconds of event time.
   */
  SAFETY_STATE_HEARTBEAT_S: envInteger(10, 86_400).default(300),
  /** How often pending vessel states are written and published, ms. */
  SAFETY_STATE_FLUSH_MS: envInteger(20, 10_000).default(250),
  /** Positions handled in parallel by the detectors (one vessel stays ordered). */
  DETECTOR_CONCURRENCY: envInteger(1, 64).default(8),
  /**
   * Pinned TTL of the exclusive position consumer, ms (kit default 30 s): a
   * standby takes over when the active instance pulled nothing for this
   * long; a gap of half of it without positions makes the instance reload
   * its open alerts (`AlertStateSync`).
   */
  DETECTOR_PINNED_TTL_MS: envInteger(2_000, 300_000).default(
    DEFAULT_PINNED_TTL_MS,
  ),
  /** Minimum time between two publications of one alert key (AlertEmitter cooldown), s. */
  ALERT_COOLDOWN_S: envInteger(0, 86_400).default(600),
  /** How long startup waits for the GEO / FLEET snapshots, ms. */
  PROJECTION_CATCH_UP_TIMEOUT_MS: envInteger(1_000, 600_000).default(60_000),
});

/** Validated configuration; inject it with `@InjectConfig() config: Config`. */
export type Config = AppConfig<typeof configSchema>;
