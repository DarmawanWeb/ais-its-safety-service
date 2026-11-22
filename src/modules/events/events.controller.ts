import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { ApiCursorResponse, UuidParam } from '@darmawanweb/ais-its-nest/http';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

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
      'Newest first by `time` (when the alert was raised; default range: the last 7 days, at most 366 days). With `status=open` and no `from`, every currently open occurrence is listed however long ago it was raised (`to` applies only when given). Each event carries the fleet identities of its vessels (`vessel`, `relatedVessel`) and, in `data` / `resolution`, the localizable text (`messageKey`, `messageParams`). Tenancy (spec §8.5): authority and super_admin see every event, other roles the events of their organization’s vessels (mmsi or relatedMmsi).',
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
  @ApiOkResponse({ type: SafetyEventDto })
  async get(
    @UuidParam() id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SafetyEventDto> {
    return new SafetyEventDto(await this.events.get(id, principal));
  }
}
