import {
  COLLISION_RISKS,
  type CollisionRisk,
  MMSI_MAX,
  MMSI_MIN,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  CursorQueryDto,
  TimeRangeQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
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

/** `GET /safety/encounters?from&to&risk&mmsi&encounterId&cursor&limit`. */
export class ListEncountersQuery extends IntersectionType(
  CursorQueryDto,
  TimeRangeQueryDto,
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
}
