import { RequirePermissions } from '@darmawanweb/ais-its-nest/auth';
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { MmsiParam } from '../../common/mmsi.param.js';
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
      'Initial state of the live map (spec §9): latest EWS status, collision risk and closest encounter per vessel, ordered by MMSI, at most `limit` vessels with a position since `since`. Shared across tenants (spec §8.5).',
  })
  @ApiOkResponse({ type: [SafetyVesselStateDto] })
  async list(
    @Query() query: ListVesselStatesQuery,
  ): Promise<SafetyVesselStateDto[]> {
    const states = await this.states.list(query);
    return states.map((state) => new SafetyVesselStateDto(state));
  }

  @Get(':mmsi')
  @RequirePermissions('safety:read')
  @ApiOperation({ summary: 'Latest safety state of one vessel' })
  @ApiOkResponse({ type: SafetyVesselStateDto })
  async get(@Param() params: MmsiParam): Promise<SafetyVesselStateDto> {
    return new SafetyVesselStateDto(await this.states.get(params.mmsi));
  }
}
