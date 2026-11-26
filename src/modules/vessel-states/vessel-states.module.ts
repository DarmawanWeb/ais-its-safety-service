import { Module } from '@nestjs/common';

import { SafetyStatsController } from './safety-stats.controller.js';
import { SafetyStatePublisher } from './safety-state.publisher.js';
import { SAFETY_STATE_SINK } from './safety-state.sink.js';
import { SafetyStateWriter } from './safety-state.writer.js';
import { VesselStatesController } from './vessel-states.controller.js';
import { VesselStatesRepository } from './vessel-states.repository.js';
import { VesselStatesService } from './vessel-states.service.js';

/**
 * Vessel safety states: the `vessel_state` table, its writer (producer of the
 * `SAFETY` stream), `GET /safety/vessels[/:mmsi]` and the counts of
 * `GET /safety/stats`.
 */
@Module({
  controllers: [VesselStatesController, SafetyStatsController],
  providers: [
    VesselStatesRepository,
    VesselStatesService,
    SafetyStatePublisher,
    SafetyStateWriter,
    { provide: SAFETY_STATE_SINK, useExisting: SafetyStateWriter },
  ],
  exports: [SAFETY_STATE_SINK, SafetyStateWriter],
})
export class VesselStatesModule {}
