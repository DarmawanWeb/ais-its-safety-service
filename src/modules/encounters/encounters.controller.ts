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
      'Encounters of vessel pairs at risk with samples in the range (default: the last 24 h, at most 31 days), newest encounter first (by start; an active encounter keeps its place while it gets new samples), each with its CPA/TCPA history in the range, the predicted positions at the closest point of approach per sample (`cpaPositions`), the fleet identities of both vessels and a localizable text (`messageKey`, `messageParams`). `active=true` keeps the encounters still in progress (latest sample above `none` and at most `COLLISION_MAX_AGE_S` + `COLLISION_SAMPLE_INTERVAL_S` + 30 s old), `active=false` the ended ones; `bbox` keeps the encounters with a sample in the range where either vessel’s report lies in the box. The cursor keeps the window (and the `active` cut-off) of the first page: every page reads the same `from` / `to`. Tenancy (spec §8.5): authority and super_admin see every pair, other roles pairs with a vessel of their organization.',
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
