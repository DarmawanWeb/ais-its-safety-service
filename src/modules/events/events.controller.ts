import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { ApiCursorResponse } from '@darmawanweb/ais-its-nest/http';
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { ListEventsQuery } from './dto/list-events.query.js';
import { SafetyEventDto } from './dto/safety-event.dto.js';
import { EventsService } from './events.service.js';

@ApiTags('events')
@Controller('safety/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @RequirePermissions('safety:read')
  @ApiOperation({
    summary: 'Safety events (EWS, collision) with their lifecycle',
    description:
      'Newest first (default: the last 7 days, at most 366 days). Tenancy (spec §8.5): authority and super_admin see every event, other roles the events of their organization’s vessels (mmsi or relatedMmsi).',
  })
  @ApiCursorResponse(SafetyEventDto)
  async list(
    @Query() query: ListEventsQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CursorPage<SafetyEventDto>> {
    const page = await this.events.list(query, principal);
    return {
      data: page.data.map((event) => new SafetyEventDto(event)),
      page: page.page,
    };
  }

  @Get(':id')
  @RequirePermissions('safety:read')
  @ApiOperation({ summary: 'One safety event' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SafetyEventDto })
  async get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SafetyEventDto> {
    return new SafetyEventDto(await this.events.get(id, principal));
  }
}
