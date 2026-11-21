import { AuthModule } from '@darmawanweb/ais-its-nest/auth';
import { DatabaseModule } from '@darmawanweb/ais-its-nest/db';
import { NatsModule } from '@darmawanweb/ais-its-nest/nats';
import { Module } from '@nestjs/common';

import { CommonModule } from './common/common.module.js';
import { ConsumersModule } from './consumers/consumers.module.js';
import * as schema from './db/schema.js';
import { DetectorsModule } from './detectors/detectors.module.js';
import { EncountersModule } from './modules/encounters/encounters.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { MethodologyModule } from './modules/methodology/methodology.module.js';
import { VesselStatesModule } from './modules/vessel-states/vessel-states.module.js';

/**
 * Root module. `bootstrapService()` wraps it in the kit's platform root module
 * (configuration, logging, metrics, health, validation, problem details).
 * Nothing connects at construction time: connections, migrations and streams
 * are set up in lifecycle hooks before the HTTP port opens.
 */
@Module({
  imports: [
    // pg pool + drizzle (search_path=<DATABASE_SCHEMA>,public); migrations on boot.
    DatabaseModule.forRoot({ schema }),
    // Streams this service PRODUCES to (created / widened at boot): vessel
    // safety states and the alerts of its detectors (spec §7.2, §13.7).
    NatsModule.forRoot({ streams: ['SAFETY', 'ALERTS'] }),
    // Global default-deny guard: every route needs a principal unless @Public().
    AuthModule.forRoot(),
    CommonModule,
    MethodologyModule,
    ConsumersModule,
    VesselStatesModule,
    EventsModule,
    EncountersModule,
    DetectorsModule,
  ],
})
export class AppModule {}
