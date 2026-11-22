import {
  COLLISION_RISKS,
  type CollisionRisk,
  MMSI_MAX,
  MMSI_MIN,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  BBoxQueryDto,
  CursorQueryDto,
  TimeRangeQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** Default range of `GET /safety/encounters` (missing `from`): the last 24 h. */
export const ENCOUNTERS_DEFAULT_RANGE_MS = 24 * 60 * 60_000;
/** Longest accepted range: 31 days. */
export const ENCOUNTERS_MAX_RANGE_MS = 31 * 24 * 60 * 60_000;

/** `true` / `false` of a query string; anything else is left for `@IsBoolean()` to reject. */
function queryBoolean({ value }: { value: unknown }): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/** `GET /safety/encounters?from&to&risk&mmsi&encounterId&active&bbox&cursor&limit`. */
export class ListEncountersQuery extends IntersectionType(
  CursorQueryDto,
  TimeRangeQueryDto,
  BBoxQueryDto,
) {
  @ApiPropertyOptional({
    type: String,
    example: 'medium,high',
    description: `Encounters whose highest band in the range is one of these, comma separated (${COLLISION_RISKS.join(', ')})`,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : value,
  )
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(COLLISION_RISKS, { each: true })
  readonly risk?: CollisionRisk[];

  @ApiPropertyOptional({ description: 'Either vessel of the pair' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MMSI_MIN)
  @Max(MMSI_MAX)
  readonly mmsi?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'One encounter',
  })
  @IsOptional()
  @IsUUID()
  readonly encounterId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      '`true`: only active encounters — the newest encounter of its pair, whose latest sample has a band above `none` and is at most `COLLISION_MAX_AGE_S` + `COLLISION_SAMPLE_INTERVAL_S` + 30 s (180 s with the defaults) older than the collision detector’s event clock: the AIS time of its newest evaluation (positions lag the wall clock), never later than the request time. `false`: only ended ones, including an encounter followed by a newer one of the same pair (a takeover or restart starts a pair over with a new `encounterId`). The cursor keeps the first page’s cut-off.',
  })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  readonly active?: boolean;
}
