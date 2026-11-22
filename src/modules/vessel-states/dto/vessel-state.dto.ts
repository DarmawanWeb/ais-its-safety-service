import {
  COLLISION_RISKS,
  type CollisionRisk,
  EWS_STATUSES,
  type EwsStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import type { ClosestEncounter } from '@darmawanweb/ais-its-contracts/events';
import { ApiProperty } from '@nestjs/swagger';

import { SafetyVesselIdentityDto } from '../../../common/vessel-identity.dto.js';
import type { PipelineIdentity, VesselStateRecord } from '../vessel-state.js';

/** The closest predicted encounter of a vessel (contracts `ClosestEncounter`). */
export class ClosestEncounterDto {
  @ApiProperty({ example: 525005224, description: 'MMSI of the other vessel' })
  readonly otherMmsi!: number;

  @ApiProperty({
    example: 0.18,
    description: 'Distance at the closest point of approach (CPA), nm',
  })
  readonly cpaNm!: number;

  @ApiProperty({
    example: 4.6,
    description: 'Time to the closest point of approach (TCPA), minutes',
  })
  readonly tcpaMin!: number;
}

/** Identity of a pipeline zone (the `zones` projection of `GEO`). */
export class PipelineIdentityDto implements PipelineIdentity {
  @ApiProperty({ format: 'uuid', description: 'Zone id' })
  readonly id!: string;

  @ApiProperty({ example: 'PL-SBY-01', description: 'Zone code' })
  readonly code!: string;

  @ApiProperty({ example: 'Pipeline Surabaya West' })
  readonly name!: string;
}

/**
 * The latest navigational safety state of a vessel. `time`, `ewsStatus`,
 * `collisionRisk` and `closestEncounter` are those of
 * `safety.vessel_state.updated.v1`; `lat`/`lon` are the vessel's latest
 * position (the realtime `RealtimeSafetyState` shape, spec §9).
 */
export class SafetyVesselStateDto {
  @ApiProperty({ example: 525005223 })
  readonly mmsi: number;

  @ApiProperty({
    format: 'date-time',
    description:
      'Event time of the latest evaluation (SafetyVesselStateV1.time)',
  })
  readonly time: string;

  @ApiProperty({ example: -6.9277, description: 'Latest latitude, degrees' })
  readonly lat: number;

  @ApiProperty({ example: 112.7085, description: 'Latest longitude, degrees' })
  readonly lon: number;

  @ApiProperty({
    format: 'date-time',
    description: 'Time of the latest position',
  })
  readonly positionTime: string;

  @ApiProperty({ description: 'Speed over ground, knots (102.3 = n/a)' })
  readonly sog: number;

  @ApiProperty({ description: 'Course over ground, degrees (360 = n/a)' })
  readonly cog: number;

  @ApiProperty({ description: 'Heading, degrees (511 = n/a)' })
  readonly hdg: number;

  @ApiProperty({ description: 'Reported AIS navigational status (0–15)' })
  readonly navstatus: number;

  @ApiProperty({ enum: [0, 1], description: '1 = predicted at anchor' })
  readonly predictedNavstatus: 0 | 1;

  @ApiProperty({
    enum: EWS_STATUSES,
    description: 'Pipeline EWS status: 0 danger, 1 warning, 3 safe',
  })
  readonly ewsStatus: EwsStatus;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Distance to the nearest active pipeline zone line that applies to the vessel (global zones and those of its own organization), meters; `null` without such a pipeline, or when it is a zone private to an organization other than the reader’s',
  })
  readonly pipelineDistanceM: number | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Zone id of that pipeline; `null` under the same conditions as `pipelineDistanceM`',
  })
  readonly nearestPipelineZoneId: string | null;

  @ApiProperty({
    type: PipelineIdentityDto,
    nullable: true,
    description:
      'Code and name of that pipeline zone (also after it was deleted, until the vessel is evaluated again); `null` under the same conditions as `pipelineDistanceM`, or when the zone is not (yet) in the `zones` projection',
  })
  readonly nearestPipeline: PipelineIdentity | null;

  @ApiProperty({ enum: COLLISION_RISKS })
  readonly collisionRisk: CollisionRisk;

  @ApiProperty({ type: ClosestEncounterDto, nullable: true })
  readonly closestEncounter: ClosestEncounter | null;

  @ApiProperty({
    type: [String],
    example: ['ews.pipeline_distance_status', 'collision.cpa_tcpa'],
    description: 'Methodology catalog ids behind the state (spec §17)',
  })
  readonly methodIds: string[];

  @ApiProperty({
    type: SafetyVesselIdentityDto,
    nullable: true,
    description:
      'Fleet identity of the vessel (shared across tenants); `null` for an unregistered MMSI',
  })
  readonly vessel: VesselStateRecord['vessel'];

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt: string;

  constructor(record: VesselStateRecord) {
    this.mmsi = record.mmsi;
    this.time = record.evaluatedAt.toISOString();
    this.lat = record.position.lat;
    this.lon = record.position.lon;
    this.positionTime = record.position.time.toISOString();
    this.sog = record.position.sog;
    this.cog = record.position.cog;
    this.hdg = record.position.hdg;
    this.navstatus = record.position.navstatus;
    this.predictedNavstatus = record.position.predictedNavstatus;
    this.ewsStatus = record.ewsStatus;
    this.pipelineDistanceM = record.pipelineDistanceM;
    this.nearestPipelineZoneId = record.nearestPipelineZoneId;
    this.nearestPipeline = record.nearestPipeline;
    this.collisionRisk = record.collisionRisk;
    this.closestEncounter = record.closestEncounter;
    this.methodIds = [...record.methodIds];
    this.vessel = record.vessel;
    this.updatedAt = record.updatedAt.toISOString();
  }
}
