import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Route parameter `:id` of an event (a malformed id is `400 VALIDATION_FAILED`). */
export class EventIdParam {
  @ApiProperty({ format: 'uuid', description: 'Event id = alert id' })
  @IsUUID()
  readonly id!: string;
}
