import {
  COLLISION_RISKS,
  type CollisionRisk,
} from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty } from '@nestjs/swagger';

import type {
  EncounterPositionsJson,
  EncounterVesselPosition,
} from '../../../db/schema.js';
import type { EncounterHistorySample, EncounterRecord } from '../encounter.js';

/** A vessel report an encounter sample was computed from. */
export class EncounterVesselPositionDto implements EncounterVesselPosition {
  @ApiProperty({ example: 525005223 })
  readonly mmsi!: number;

  @ApiProperty({ format: 'date-time', description: 'Time of the report' })
  readonly time!: string;

  @ApiProperty()
  readonly lat!: number;

  @ApiProperty()
  readonly lon!: number;

  @ApiProperty({ description: 'Speed over ground, knots' })
  readonly sog!: number;

  @ApiProperty({ description: 'Course over ground, degrees' })
  readonly cog!: number;
}

/** The two reports of a sample (`a` = lower MMSI). */
export class EncounterPositionsDto implements EncounterPositionsJson {
  @ApiProperty({ type: EncounterVesselPositionDto })
  readonly a!: EncounterVesselPositionDto;

  @ApiProperty({ type: EncounterVesselPositionDto })
  readonly b!: EncounterVesselPositionDto;
}

/** One CPA/TCPA evaluation of the pair. */
export class EncounterSampleDto {
  @ApiProperty({
    format: 'date-time',
    description: 'Event time of the evaluation',
  })
  readonly time: string;

  @ApiProperty({ description: 'Distance at the closest point of approach, nm' })
  readonly cpaNm: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Time to the closest point of approach, minutes (null: no relative motion)',
  })
  readonly tcpaMin: number | null;

  @ApiProperty({
    description: 'Range between the vessels at the evaluation, nm',
  })
  readonly rangeNm: number;

  @ApiProperty({
    enum: COLLISION_RISKS,
    description: 'Risk band after hysteresis',
  })
  readonly risk: CollisionRisk;

  @ApiProperty({ type: EncounterPositionsDto })
  readonly positions: EncounterPositionsJson;

  constructor(sample: EncounterHistorySample) {
    this.time = sample.time.toISOString();
    this.cpaNm = sample.cpaNm;
    this.tcpaMin = sample.tcpaMin;
    this.rangeNm = sample.rangeNm;
    this.risk = sample.risk;
    this.positions = sample.positions;
  }
}

/**
 * A collision encounter of a vessel pair (from its first band above `none`
 * to the return to `none`) with its CPA/TCPA history in the queried range.
 */
export class EncounterDto {
  @ApiProperty({ format: 'uuid' })
  readonly encounterId: string;

  @ApiProperty({ example: 525005223, description: 'Lower MMSI of the pair' })
  readonly mmsiA: number;

  @ApiProperty({ example: 525005224, description: 'Higher MMSI of the pair' })
  readonly mmsiB: number;

  @ApiProperty({
    format: 'date-time',
    description: 'First sample in the range',
  })
  readonly startedAt: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Latest sample in the range',
  })
  readonly lastSampleAt: string;

  @ApiProperty({
    enum: COLLISION_RISKS,
    description: 'Highest band of the samples in the range',
  })
  readonly peakRisk: CollisionRisk;

  @ApiProperty({
    description: 'Smallest CPA of the samples in the range, nm',
  })
  readonly minCpaNm: number;

  @ApiProperty({
    type: [EncounterSampleDto],
    description: 'CPA/TCPA samples in the range, oldest first',
  })
  readonly history: EncounterSampleDto[];

  constructor(record: EncounterRecord) {
    this.encounterId = record.encounterId;
    this.mmsiA = record.mmsiA;
    this.mmsiB = record.mmsiB;
    this.startedAt = record.startedAt.toISOString();
    this.lastSampleAt = record.lastSampleAt.toISOString();
    this.peakRisk = record.peakRisk;
    this.minCpaNm = record.minCpaNm;
    this.history = record.history.map(
      (sample) => new EncounterSampleDto(sample),
    );
  }
}
