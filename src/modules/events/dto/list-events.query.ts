import {
  ALERT_SEVERITIES,
  type AlertSeverity,
  MMSI_MAX,
  MMSI_MIN,
  SAFETY_EVENT_STATUSES,
  type SafetyEventStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import { DETECTOR_ID_PATTERN } from '@darmawanweb/ais-its-nest/analytics';
import {
  BBoxQueryDto,
  CursorQueryDto,
  TimeRangeQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

/** Default range of `GET /safety/events` (missing `from`): the last 7 days. */
export const EVENTS_DEFAULT_RANGE_MS = 7 * 24 * 60 * 60_000;
/** Longest accepted range: 366 days. */
export const EVENTS_MAX_RANGE_MS = 366 * 24 * 60 * 60_000;

/** `GET /safety/events?detector&severity&status&mmsi&from&to&bbox&cursor&limit`. */
export class ListEventsQuery extends IntersectionType(
  CursorQueryDto,
  TimeRangeQueryDto,
  BBoxQueryDto,
) {
  @ApiPropertyOptional({
    example: 'ews',
    description: 'Detector id (`ews`, `collision`, …)',
  })
  @IsOptional()
  @Matches(DETECTOR_ID_PATTERN)
  readonly detector?: string;

  @ApiPropertyOptional({ enum: ALERT_SEVERITIES })
  @IsOptional()
  @IsIn(ALERT_SEVERITIES)
  readonly severity?: AlertSeverity;

  @ApiPropertyOptional({ enum: SAFETY_EVENT_STATUSES })
  @IsOptional()
  @IsIn(SAFETY_EVENT_STATUSES)
  readonly status?: SafetyEventStatus;

  @ApiPropertyOptional({ description: 'Vessel, as mmsi or relatedMmsi' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MMSI_MIN)
  @Max(MMSI_MAX)
  readonly mmsi?: number;
}
