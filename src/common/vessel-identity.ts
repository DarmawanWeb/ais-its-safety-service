import type { Database } from '@darmawanweb/ais-its-nest/db';
import { and, inArray, isNull } from 'drizzle-orm';

import * as schema from '../db/schema.js';

const { vessels } = schema;

/**
 * Fleet identity of a registered vessel as the REST API shows it next to an
 * MMSI. Vessel identity is shared across tenants (spec §8.5), so every
 * reader of an event or encounter may see both vessels' names.
 */
export interface VesselIdentity {
  readonly id: string;
  readonly name: string;
  /** Vessel type code of the fleet registry, `null` when unknown. */
  readonly typeCode: string | null;
}

/**
 * The identities of the live (not deleted) vessels with these MMSIs, from
 * the `vessels` projection of `FLEET` (one live vessel per MMSI); MMSIs of
 * unregistered vessels are absent. One indexed query (`vessels_mmsi_key`).
 */
export async function vesselIdentities(
  db: Database<typeof schema>,
  mmsis: Iterable<number | null>,
): Promise<ReadonlyMap<number, VesselIdentity>> {
  const wanted = [
    ...new Set([...mmsis].filter((mmsi): mmsi is number => mmsi !== null)),
  ];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({
      id: vessels.id,
      mmsi: vessels.mmsi,
      name: vessels.name,
      typeCode: vessels.typeCode,
    })
    .from(vessels)
    .where(and(inArray(vessels.mmsi, wanted), isNull(vessels.deletedAt)));
  return new Map(
    rows.map((row) => [
      row.mmsi,
      { id: row.id, name: row.name, typeCode: row.typeCode },
    ]),
  );
}
