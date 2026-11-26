import { ApiProperty } from '@nestjs/swagger';

import { EWS_METHOD_ID } from '../../../domain/ews.js';
import { COLLISION_METHOD_ID } from '../../../domain/safety-state.js';
import type { SafetyStatsRecord } from '../vessel-state.js';

/** Vessels per alerting EWS status. */
export class EwsStatsDto {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    example: 2,
    description: 'Vessels whose latest EWS status is danger (`0`)',
  })
  readonly danger: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    example: 5,
    description: 'Vessels whose latest EWS status is warning (`1`)',
  })
  readonly warning: number;

  @ApiProperty({
    example: EWS_METHOD_ID,
    description: 'Methodology catalog id of the EWS status (spec §17)',
  })
  readonly methodId: string;

  constructor(counts: SafetyStatsRecord['ews']) {
    this.danger = counts.danger;
    this.warning = counts.warning;
    this.methodId = EWS_METHOD_ID;
  }
}

/** Vessels per alerting collision risk band. */
export class CollisionStatsDto {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    example: 1,
    description:
      'Vessels whose latest collision risk is `high` (critical alerts)',
  })
  readonly high: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    example: 3,
    description:
      'Vessels whose latest collision risk is `medium` (warning alerts)',
  })
  readonly medium: number;

  @ApiProperty({
    example: COLLISION_METHOD_ID,
    description: 'Methodology catalog id of the risk bands (spec §17)',
  })
  readonly methodId: string;

  constructor(counts: SafetyStatsRecord['collision']) {
    this.high = counts.high;
    this.medium = counts.medium;
    this.methodId = COLLISION_METHOD_ID;
  }
}

/** `GET /safety/stats`: vessels at risk among the latest safety states. */
export class SafetyStatsDto {
  @ApiProperty({ type: EwsStatsDto })
  readonly ews: EwsStatsDto;

  @ApiProperty({ type: CollisionStatsDto })
  readonly collision: CollisionStatsDto;

  @ApiProperty({
    format: 'date-time',
    description:
      'Only vessels with a position at or after this time were counted (`since`, default 24 h before `at`)',
  })
  readonly since: string;

  @ApiProperty({
    format: 'date-time',
    description: 'When the counts were taken',
  })
  readonly at: string;

  constructor(record: SafetyStatsRecord) {
    this.ews = new EwsStatsDto(record.ews);
    this.collision = new CollisionStatsDto(record.collision);
    this.since = record.since.toISOString();
    this.at = record.at.toISOString();
  }
}
