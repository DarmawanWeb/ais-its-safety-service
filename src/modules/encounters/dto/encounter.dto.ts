import {
  COLLISION_RISKS,
  type CollisionRisk,
} from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty } from '@nestjs/swagger';

import type {
  EncounterPositionsJson,
  EncounterVesselPosition,
} from '../../../db/schema.js';
import type { EncounterRow } from '../encounters.repository.js';

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

/** One CPA/TCPA evaluation of a vessel pair at risk. */
export class EncounterSampleDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Groups the samples of one encounter',
  })
  readonly encounterId: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Event time of the evaluation',
  })
  readonly time: string;

  @ApiProperty({ example: 525005223, description: 'Lower MMSI of the pair' })
  readonly mmsiA: number;

  @ApiProperty({ example: 525005224, description: 'Higher MMSI of the pair' })
  readonly mmsiB: number;

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

  constructor(row: EncounterRow) {
    this.encounterId = row.encounterId;
    this.time = row.time.toISOString();
    this.mmsiA = row.mmsiA;
    this.mmsiB = row.mmsiB;
    this.cpaNm = row.cpaNm;
    this.tcpaMin = row.tcpaMin;
    this.rangeNm = row.rangeNm;
    this.risk = row.risk;
    this.positions = row.positions;
  }
}
