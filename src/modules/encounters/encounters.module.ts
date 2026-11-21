import { Module } from '@nestjs/common';

import { ENCOUNTER_SINK } from './encounter.js';
import { EncounterRecorder } from './encounter.recorder.js';
import { EncountersController } from './encounters.controller.js';
import { EncountersRepository } from './encounters.repository.js';
import { EncountersService } from './encounters.service.js';

/** Collision encounter samples: the detector's sink and `GET /safety/encounters`. */
@Module({
  controllers: [EncountersController],
  providers: [
    EncountersRepository,
    EncountersService,
    EncounterRecorder,
    { provide: ENCOUNTER_SINK, useExisting: EncounterRecorder },
  ],
  exports: [ENCOUNTER_SINK],
})
export class EncountersModule {}
