import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { MmsiParam } from '@darmawanweb/ais-its-nest/http';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ListVesselStatesQuery } from './dto/list-vessel-states.query.js';
import { SafetyVesselStateDto } from './dto/vessel-state.dto.js';
import { VesselStatesService } from './vessel-states.service.js';

@ApiTags('vessels')
@Controller('safety/vessels')
export class VesselStatesController {
  constructor(private readonly states: VesselStatesService) {}

  @Get()
  @RequirePermissions('safety:read')
  @ApiOperation({
    summary: 'Latest safety states of the vessels in a viewport',
    description:
      'Initial state of the live map (spec §9): latest EWS status, collision risk and closest encounter per vessel, ordered by MMSI, at most `limit` vessels with a position since `since`, with the vessel’s fleet identity and the nearest pipeline’s code and name. Shared across tenants (spec §8.5), except the nearest pipeline when it is a zone private to another organization: `nearestPipelineZoneId`, `nearestPipeline` and `pipelineDistanceM` are then `null` (authority and super_admin see every zone).',
  })
  @ApiOkResponse({ type: [SafetyVesselStateDto] })
  async list(
    @Query() query: ListVesselStatesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SafetyVesselStateDto[]> {
    const states = await this.states.list(query, principal);
    return states.map((state) => new SafetyVesselStateDto(state));
  }

  @Get(':mmsi')
  @RequirePermissions('safety:read')
  @ApiOperation({
    summary: 'Latest safety state of one vessel',
    description:
      'Same visibility as the list: the nearest pipeline (id, identity, distance) is `null` when it is a zone private to another organization.',
  })
  @ApiOkResponse({ type: SafetyVesselStateDto })
  async get(
    @MmsiParam() mmsi: number,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SafetyVesselStateDto> {
    return new SafetyVesselStateDto(await this.states.get(mmsi, principal));
  }
}
