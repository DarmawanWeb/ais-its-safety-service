import {
  COLLISION_RISKS,
  type CollisionRisk,
} from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty } from '@nestjs/swagger';

import type { VesselIdentity } from '../../../common/vessel-identity.js';
import { SafetyVesselIdentityDto } from '../../../common/vessel-identity.dto.js';
import type {
  EncounterPositionsJson,
  EncounterVesselPosition,
} from '../../../db/schema.js';
import {
  localizable,
  MESSAGE_KEYS,
  type MessageParams,
  metresOfNm,
  rounded,
} from '../../../detectors/alert-text.js';
import { vesselLabel } from '../../../detectors/vessel-kinematics.js';
import {
  type CpaPositions,
  predictedCpaPositions,
  type TimedMotionState,
} from '../../../domain/cpa.js';
import type { EncounterHistorySample, EncounterRecord } from '../encounter.js';

/** A latitude / longitude pair, degrees (WGS 84). */
export class LatLonDto {
  @ApiProperty({ example: -6.9 })
  readonly lat!: number;

  @ApiProperty({ example: 112.75 })
  readonly lon!: number;
}

/** Predicted positions of both vessels at the closest point of approach (`a` = lower MMSI). */
export class CpaPositionsDto implements CpaPositions {
  @ApiProperty({ type: LatLonDto })
  readonly a!: LatLonDto;

  @ApiProperty({ type: LatLonDto })
  readonly b!: LatLonDto;
}

/** The report of a sample as the input of the CPA prediction. */
function motionOf(report: EncounterVesselPosition): TimedMotionState {
  return {
    time: new Date(report.time),
    lat: report.lat,
    lon: report.lon,
    sogKn: report.sog,
    cogDeg: report.cog,
  };
}

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

  @ApiProperty({
    type: CpaPositionsDto,
    nullable: true,
    description:
      'Predicted positions of both vessels at the closest point of approach (method `collision.cpa_tcpa`): each report dead-reckoned on constant SOG/COG to `time` + `tcpaMin`. `null` without relative motion (`tcpaMin` `null`) or when the closest point lies in the past (`tcpaMin` < 0)',
  })
  readonly cpaPositions: CpaPositions | null;

  constructor(sample: EncounterHistorySample) {
    this.time = sample.time.toISOString();
    this.cpaNm = sample.cpaNm;
    this.tcpaMin = sample.tcpaMin;
    this.rangeNm = sample.rangeNm;
    this.risk = sample.risk;
    this.positions = sample.positions;
    this.cpaPositions =
      predictedCpaPositions(
        motionOf(sample.positions.a),
        motionOf(sample.positions.b),
        sample.time,
        sample.tcpaMin,
      ) ?? null;
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
    type: SafetyVesselIdentityDto,
    nullable: true,
    description:
      'Fleet identity of `mmsiA` (shared across tenants, spec §8.5); `null` for an unregistered MMSI',
  })
  readonly vesselA: VesselIdentity | null;

  @ApiProperty({
    type: SafetyVesselIdentityDto,
    nullable: true,
    description: 'Fleet identity of `mmsiB`; `null` for an unregistered MMSI',
  })
  readonly vesselB: VesselIdentity | null;

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

  @ApiProperty({
    example: 'safety.collision.encounter',
    description:
      'Stable key of the encounter’s sentence (README "Localizable texts"): `safety.collision.encounter`',
  })
  readonly messageKey: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    example: {
      vesselA: 'KM Silang (MMSI 525005223)',
      mmsiA: 525005223,
      vesselB: 'MMSI 525005224',
      mmsiB: 525005224,
      peakRisk: 'high',
      minCpaM: 157,
      minCpaNm: 0.08,
    },
    description:
      'Values of the sentence: `vesselA` / `vesselB` (name with MMSI, or the MMSI), `mmsiA`, `mmsiB`, `peakRisk`, `minCpaM` (whole metres, the platform unit of distance params) and `minCpaNm` (2 decimals, the unit of the English sentence)',
  })
  readonly messageParams: MessageParams;

  constructor(record: EncounterRecord) {
    this.encounterId = record.encounterId;
    this.mmsiA = record.mmsiA;
    this.mmsiB = record.mmsiB;
    this.vesselA = record.vesselA;
    this.vesselB = record.vesselB;
    this.startedAt = record.startedAt.toISOString();
    this.lastSampleAt = record.lastSampleAt.toISOString();
    this.peakRisk = record.peakRisk;
    this.minCpaNm = record.minCpaNm;
    this.history = record.history.map(
      (sample) => new EncounterSampleDto(sample),
    );
    const text = localizable(MESSAGE_KEYS.collisionEncounter, {
      vesselA: vesselLabel(record.mmsiA, record.vesselA?.name),
      mmsiA: record.mmsiA,
      vesselB: vesselLabel(record.mmsiB, record.vesselB?.name),
      mmsiB: record.mmsiB,
      peakRisk: record.peakRisk,
      minCpaM: metresOfNm(record.minCpaNm),
      minCpaNm: rounded(record.minCpaNm, 2),
    });
    this.messageKey = text.messageKey;
    this.messageParams = text.messageParams;
  }
}
