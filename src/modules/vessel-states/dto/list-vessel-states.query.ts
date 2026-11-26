import {
  COLLISION_RISKS,
  type CollisionRisk,
  EWS_STATUSES,
  type EwsStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import { IsBBox } from '@darmawanweb/ais-its-nest/http';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  buildMessage,
  IS_ISO8601,
  IsArray,
  IsIn,
  IsInt,
  isISO8601,
  IsOptional,
  Max,
  Min,
  ValidateBy,
} from 'class-validator';

/** Default and largest `limit` of `GET /safety/vessels` (a map viewport seed). */
export const VESSEL_STATES_DEFAULT_LIMIT = 5000;
export const VESSEL_STATES_MAX_LIMIT = 10_000;

/** Default `since`: vessels with a position in the last 24 h. */
export const VESSEL_STATES_DEFAULT_SINCE_MS = 24 * 60 * 60_000;

/**
 * An ISO-8601 date-time that `Date` reads: `IsISO8601({ strict: true,
 * strictSeparator: true })` also accepts forms `Date` cannot parse (week and
 * ordinal dates, the basic format, hour-only or colon-less times, comma
 * fractions, signed years), which would reach the query as an invalid date
 * and fail with `500` instead of `400`. Same constraint (`code`) as
 * `IsISO8601`.
 */
export function IsIsoDateTime(): PropertyDecorator {
  return ValidateBy({
    name: IS_ISO8601,
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        isISO8601(value, { strict: true, strictSeparator: true }) &&
        !Number.isNaN(Date.parse(value)),
      defaultMessage: buildMessage(
        (each) => `${each}$property must be a valid ISO 8601 date-time`,
      ),
    },
  });
}

/** Splits a comma separated query value (`0,1`) into trimmed items. */
function commaList({ value }: { value: unknown }): unknown {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : value;
}

/** `GET /safety/vessels?bbox&ewsStatus&collisionRisk&since&limit`. */
export class ListVesselStatesQuery {
  @ApiPropertyOptional({
    example: '112.5,-7.3,113,-6.8',
    description: 'minLon,minLat,maxLon,maxLat (WGS 84)',
  })
  @IsOptional()
  @IsBBox()
  readonly bbox?: string;

  @ApiPropertyOptional({
    type: String,
    example: '0,1',
    description: 'EWS statuses, comma separated (0 danger, 1 warning, 3 safe)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    const items = commaList({ value });
    return Array.isArray(items) ? items.map(Number) : items;
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(EWS_STATUSES, { each: true })
  readonly ewsStatus?: EwsStatus[];

  @ApiPropertyOptional({
    type: String,
    example: 'medium,high',
    description: `Collision risk bands, comma separated (${COLLISION_RISKS.join(', ')})`,
  })
  @IsOptional()
  @Transform(commaList)
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(COLLISION_RISKS, { each: true })
  readonly collisionRisk?: CollisionRisk[];

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Only vessels with a position at or after this time (default: 24 h ago)',
  })
  @IsOptional()
  @IsIsoDateTime()
  readonly since?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: VESSEL_STATES_MAX_LIMIT,
    default: VESSEL_STATES_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(VESSEL_STATES_MAX_LIMIT)
  readonly limit: number = VESSEL_STATES_DEFAULT_LIMIT;
}
