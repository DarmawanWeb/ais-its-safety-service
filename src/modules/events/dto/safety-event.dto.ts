import {
  ALERT_DOMAINS,
  ALERT_SEVERITIES,
  type AlertDomain,
  type AlertSeverity,
  SAFETY_EVENT_STATUSES,
  type SafetyEventStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty } from '@nestjs/swagger';

import type { VesselIdentity } from '../../../common/vessel-identity.js';
import { SafetyVesselIdentityDto } from '../../../common/vessel-identity.dto.js';
import type { EventRecord } from '../events.repository.js';

/**
 * A detector event: one published `alert.raised.v1` and its lifecycle
 * (`open` → `resolved`). An escalation resolves the event it supersedes and
 * opens a new one with the same `dedupKey`.
 */
export class SafetyEventDto {
  @ApiProperty({ format: 'uuid', description: 'Event id = alert id' })
  readonly id: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'When the condition occurred: event (AIS) time of the alert, never changed afterwards (the list is ordered and filtered by it)',
  })
  readonly time: string;

  @ApiProperty({ example: 'ews', description: 'Detector that raised it' })
  readonly detector: string;

  @ApiProperty({
    example: 'ews',
    description: 'Alert type (contracts ALERT_TYPES)',
  })
  readonly type: string;

  @ApiProperty({ enum: ALERT_DOMAINS })
  readonly domain: AlertDomain;

  @ApiProperty({
    enum: ALERT_SEVERITIES,
    description: 'Severity of the published alert',
  })
  readonly severity: AlertSeverity;

  @ApiProperty({
    enum: ALERT_SEVERITIES,
    description:
      'Current severity of the occurrence (lower after a de-escalation)',
  })
  readonly currentSeverity: AlertSeverity;

  @ApiProperty({ enum: SAFETY_EVENT_STATUSES })
  readonly status: SafetyEventStatus;

  @ApiProperty({ example: 525005223 })
  readonly mmsi: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Other vessel (collision)',
  })
  readonly relatedMmsi: number | null;

  @ApiProperty({
    type: SafetyVesselIdentityDto,
    nullable: true,
    description:
      'Fleet identity of `mmsi` (shared across tenants, spec §8.5); `null` for an unregistered MMSI',
  })
  readonly vessel: VesselIdentity | null;

  @ApiProperty({
    type: SafetyVesselIdentityDto,
    nullable: true,
    description:
      'Fleet identity of `relatedMmsi`; `null` without a related vessel or for an unregistered MMSI',
  })
  readonly relatedVessel: VesselIdentity | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Zone (EWS: the pipeline)',
  })
  readonly zoneId: string | null;

  @ApiProperty({ type: Number, nullable: true })
  readonly lat: number | null;

  @ApiProperty({ type: Number, nullable: true })
  readonly lon: number | null;

  @ApiProperty()
  readonly title: string;

  @ApiProperty()
  readonly message: string;

  @ApiProperty({
    example: 'ews.pipeline_distance_status',
    description: 'Methodology catalog id of the rule (spec §17)',
  })
  readonly methodId: string;

  @ApiProperty({ example: 'ews:525005223:0195f3c4-…' })
  readonly dedupKey: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Detector specific details (distances, thresholds, CPA/TCPA, …) and the localizable text of the alert: `messageKey` (stable key, README "Localizable texts") with `messageParams` (absent on events stored before 0.2.0)',
  })
  readonly data: Record<string, unknown>;

  @ApiProperty({
    format: 'date-time',
    description:
      'When the occurrence opened (event time; an escalation keeps the opening of the alert it supersedes)',
  })
  readonly openedAt: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'Event (AIS) time of the latest signal of the condition: the alert itself, then its repeats (recorded at most every 60 s while the severity holds) and de-escalations. A resolution does not move it (see `resolvedAt`).',
  })
  readonly lastSeenAt: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the occurrence ended: event time of the position that ended it (the detector clock for zone changes and the collision housekeeping tick)',
  })
  readonly resolvedAt: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'Why and how it ended: `reason` (English), the last measurements and the localizable text `messageKey` / `messageParams` (absent on events resolved before 0.2.0)',
  })
  readonly resolution: Record<string, unknown> | null;

  constructor(record: EventRecord) {
    this.id = record.id;
    this.time = record.time.toISOString();
    this.detector = record.detector;
    this.type = record.type;
    this.domain = record.domain;
    this.severity = record.severity;
    this.currentSeverity = record.currentSeverity;
    this.status = record.status;
    this.mmsi = record.mmsi;
    this.relatedMmsi = record.relatedMmsi;
    this.vessel = record.vessel;
    this.relatedVessel = record.relatedVessel;
    this.zoneId = record.zoneId;
    this.lat = record.lat;
    this.lon = record.lon;
    this.title = record.title;
    this.message = record.message;
    this.methodId = record.methodId;
    this.dedupKey = record.dedupKey;
    this.data = record.data;
    this.openedAt = record.openedAt.toISOString();
    this.lastSeenAt = record.lastSeenAt.toISOString();
    this.resolvedAt = record.resolvedAt?.toISOString() ?? null;
    this.resolution = record.resolution;
  }
}
