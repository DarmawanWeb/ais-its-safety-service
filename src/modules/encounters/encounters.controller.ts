import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { ApiCursorResponse } from '@darmawanweb/ais-its-nest/http';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { EncounterDto } from './dto/encounter.dto.js';
import { ListEncountersQuery } from './dto/list-encounters.query.js';
import { EncountersService } from './encounters.service.js';

@ApiTags('encounters')
@Controller('safety/encounters')
export class EncountersController {
  constructor(private readonly encounters: EncountersService) {}

  @Get()
  @RequirePermissions('safety:read')
  @ApiOperation({
    summary: 'Collision encounters with their CPA/TCPA history',
    description:
      'Encounters of vessel pairs at risk with samples in the range (default: the last 24 h, at most 31 days), latest sample first, each with its CPA/TCPA history in the range. Tenancy (spec §8.5): authority and super_admin see every pair, other roles pairs with a vessel of their organization.',
  })
  @ApiCursorResponse(EncounterDto)
  async list(
    @Query() query: ListEncountersQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CursorPage<EncounterDto>> {
    const page = await this.encounters.list(query, principal);
    return {
      data: page.data.map((record) => new EncounterDto(record)),
      page: page.page,
    };
  }
}
