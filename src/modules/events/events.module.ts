import { Module } from '@nestjs/common';

import { EventsController } from './events.controller.js';
import { EventsRepository } from './events.repository.js';
import { EventsService } from './events.service.js';

/** `GET /safety/events[/:id]` over the `events` hypertable. */
@Module({
  controllers: [EventsController],
  providers: [EventsRepository, EventsService],
})
export class EventsModule {}
