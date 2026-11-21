import { Module } from '@nestjs/common';

import { ProjectionRebuildService } from './projection-rebuild.service.js';
import { ProjectionsConsumer } from './projections.consumer.js';
import { VesselsRepository } from './vessels.repository.js';
import { ZonesRepository } from './zones.repository.js';

/** Durable `GEO` / `FLEET` projections (`safety-zones`, `safety-fleet`) and their startup rebuild. */
@Module({
  providers: [
    ZonesRepository,
    VesselsRepository,
    ProjectionsConsumer,
    ProjectionRebuildService,
  ],
})
export class ConsumersModule {}
