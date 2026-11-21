import { type SQL, type SQLWrapper, sql } from 'drizzle-orm';

import { vessels } from '../db/schema.js';
import type { SafetyReadScope } from './tenancy.js';

/**
 * SQL condition of a {@link SafetyReadScope} over rows identified by one or
 * more MMSI columns (`mmsi`, `related_mmsi`, …): `undefined` for `all`,
 * `false` for `none`, otherwise "one of the MMSIs is a vessel of the
 * organization" (the `vessels` projection of the `FLEET` stream, spec §8.5).
 */
export function scopeCondition(
  scope: SafetyReadScope,
  mmsiColumns: readonly SQLWrapper[],
): SQL | undefined {
  switch (scope.kind) {
    case 'all':
      return undefined;
    case 'none':
      return sql`false`;
    case 'org':
      return sql`EXISTS (SELECT 1 FROM ${vessels} WHERE ${vessels.deletedAt} IS NULL AND ${vessels.orgId} = ${scope.orgId} AND ${vessels.mmsi} IN (${sql.join([...mmsiColumns], sql`, `)}))`;
  }
}
