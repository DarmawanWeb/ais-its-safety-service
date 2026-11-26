import { RequirePermissions } from '@darmawanweb/ais-its-nest/auth';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SafetyStatsDto } from './dto/safety-stats.dto.js';
import { SafetyStatsQuery } from './dto/safety-stats.query.js';
import { VesselStatesService } from './vessel-states.service.js';

@ApiTags('stats')
@Controller('safety/stats')
export class SafetyStatsController {
  constructor(private readonly states: VesselStatesService) {}

  @Get()
  @RequirePermissions('safety:read')
  @ApiOperation({
    summary:
      'Vessels at risk: EWS danger / warning and collision risk high / medium',
    description:
      'Counts for dashboards, taken in the database instead of listing the states: among the vessels `GET /safety/vessels` would list for `bbox` and `since` (a position at or after `since`, default 24 h ago), without its `limit`, the vessels whose latest EWS status is danger (`0`) or warning (`1`) and those whose latest collision risk is `high` or `medium` (the bands that raise alerts). A vessel counts in both groups when both apply. Shared across tenants like the states (spec §8.5): every reader gets the same counts, also for a vessel near a pipeline zone private to another organization (only the zone is hidden in the states, never the EWS status). `since` echoes the lower bound applied, `at` is when the counts were taken; each group names its methodology id.',
  })
  @ApiOkResponse({ type: SafetyStatsDto })
  async stats(@Query() query: SafetyStatsQuery): Promise<SafetyStatsDto> {
    return new SafetyStatsDto(await this.states.stats(query));
  }
}
