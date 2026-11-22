import { ApiProperty } from '@nestjs/swagger';

import type { VesselIdentity } from './vessel-identity.js';

/**
 * Fleet identity of a registered vessel (the `vessels` projection of
 * `FLEET`), shared across tenants (spec §8.5); `null` where it appears for
 * an MMSI that no live fleet vessel has.
 */
export class SafetyVesselIdentityDto implements VesselIdentity {
  @ApiProperty({ format: 'uuid', description: 'Fleet vessel id' })
  readonly id!: string;

  @ApiProperty({ example: 'KM Bahari Nusantara' })
  readonly name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'tanker',
    description: 'Vessel type code of the fleet registry',
  })
  readonly typeCode!: string | null;
}
