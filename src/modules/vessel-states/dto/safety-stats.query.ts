import { PickType } from '@nestjs/swagger';

import { ListVesselStatesQuery } from './list-vessel-states.query.js';

/**
 * `GET /safety/stats?bbox&since`: the window of `GET /safety/vessels` (same
 * validation and defaults), without its status filters and `limit` — every
 * vessel of the window is counted.
 */
export class SafetyStatsQuery extends PickType(ListVesselStatesQuery, [
  'bbox',
  'since',
] as const) {}
