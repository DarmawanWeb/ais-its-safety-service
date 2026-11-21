import { APP_CONFIG } from '@darmawanweb/ais-its-nest';
import { DetectorRunnerModule } from '@darmawanweb/ais-its-nest/analytics';
import { Module } from '@nestjs/common';

import type { Config } from '../config.js';
import { EncountersModule } from '../modules/encounters/encounters.module.js';
import { VesselStatesModule } from '../modules/vessel-states/vessel-states.module.js';
import { CollisionDetector } from './collision/collision.detector.js';
import { COLLISION_MAX_AGE_LIMIT_S } from './collision/collision.config.js';
import { DetectorEventsRepository } from './detector-events.repository.js';
import { DetectorsController } from './detectors.controller.js';
import { EwsDetector } from './ews/ews.detector.js';

/** Grid cell of the neighbour search: 2 nm, a third of the default 6 nm radius. */
const PAIR_SEARCH_CELL_M = 3704;

/**
 * Detector SDK wiring (spec §18). The runner consumes `AIS_POSITION` through
 * the durable `safety-positions` (a `DETECTORS` subset through
 * `safety-positions-<ids>`), keeps the `GEO` and `FLEET` projections in
 * memory, runs the enabled detectors and publishes their alerts to `ALERTS`
 * after `DetectorEventsRepository` stored them.
 *
 * Distances use the `'sphere'` model: it reproduces Turf.js 7, which the
 * legacy EWS rule used, to 1e-6 m (the `'wgs84'` default differs by up to
 * 13 m, enough to flip a status at the 500 / 1 750 m thresholds).
 */
@Module({
  imports: [
    VesselStatesModule,
    EncountersModule,
    DetectorRunnerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: Config) => ({
        positions: 'safety-positions',
        concurrency: config.DETECTOR_CONCURRENCY,
        distanceModel: 'sphere',
        alertCooldownMs: config.ALERT_COOLDOWN_S * 1000,
        catchUpTimeoutMs: config.PROJECTION_CATCH_UP_TIMEOUT_MS,
        pairSearch: {
          cellSizeM: PAIR_SEARCH_CELL_M,
          maxAgeMs: COLLISION_MAX_AGE_LIMIT_S * 1000,
        },
      }),
      persistence: { useClass: DetectorEventsRepository },
    }),
  ],
  controllers: [DetectorsController],
  providers: [EwsDetector, CollisionDetector],
})
export class DetectorsModule {}
