import { MMSI_MAX, MMSI_MIN } from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/** Route parameter `:mmsi` (9 digits). */
export class MmsiParam {
  @ApiProperty({ example: 525005223, minimum: MMSI_MIN, maximum: MMSI_MAX })
  @Type(() => Number)
  @IsInt()
  @Min(MMSI_MIN)
  @Max(MMSI_MAX)
  readonly mmsi!: number;
}
