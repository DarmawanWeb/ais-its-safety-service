import { Module } from '@nestjs/common';

import { SafetyStatePublisher } from './safety-state.publisher.js';
import { SAFETY_STATE_SINK } from './safety-state.sink.js';
import { SafetyStateWriter } from './safety-state.writer.js';
import { VesselStatesController } from './vessel-states.controller.js';
import { VesselStatesRepository } from './vessel-states.repository.js';
import { VesselStatesService } from './vessel-states.service.js';

/**
 * Vessel safety states: the `vessel_state` table, its writer (producer of the
 * `SAFETY` stream) and `GET /safety/vessels[/:mmsi]`.
 */
@Module({
  controllers: [VesselStatesController],
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
