import type {
  VesselDeletedV1,
  VesselSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, eq, isNull, lt, lte, ne, sql } from 'drizzle-orm';

import * as schema from '../db/schema.js';
import { isUniqueViolation } from '../db/errors.js';

const { vessels } = schema;

/** Outcome of {@link VesselsRepository.upsert}. */
export type VesselUpsertOutcome =
  /** The snapshot was stored. */
  | 'applied'
  /** The stored snapshot (or tombstone) is newer. */
  | 'stale'
  /** A newer live vessel holds the MMSI. */
  | 'mmsi_taken';

/**
 * Projection of the `FLEET` stream: vessel id → MMSI, organization (the
 * tenancy of safety events, spec §8.5). Newest snapshot wins, deletions are
 * tombstoned, one live vessel per MMSI.
 */
@Injectable()
export class VesselsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** Applies a snapshot when it is newer. Idempotent. */
  async upsert(vessel: VesselSnapshotV1): Promise<VesselUpsertOutcome> {
    const updatedAt = new Date(vessel.updatedAt);
    try {
      return await this.db.transaction(async (tx) => {
        // An older live vessel with the same MMSI was replaced (e.g. re-registered).
        await tx
          .update(vessels)
          .set({ deletedAt: updatedAt, updatedAt: sql`now()` })
          .where(
            and(
              eq(vessels.mmsi, vessel.mmsi),
              ne(vessels.id, vessel.id),
              isNull(vessels.deletedAt),
              lte(vessels.sourceUpdatedAt, updatedAt),
            ),
          );
        const rows = await tx
          .insert(vessels)
          .values({
            id: vessel.id,
            mmsi: vessel.mmsi,
            orgId: vessel.orgId,
            name: vessel.name,
            imo: vessel.imo,
            flag: vessel.flag,
            typeCode: vessel.type.code,
            status: vessel.status,
            sourceUpdatedAt: updatedAt,
          })
          .onConflictDoUpdate({
            target: vessels.id,
            set: {
              mmsi: sql`excluded.mmsi`,
              orgId: sql`excluded.org_id`,
              name: sql`excluded.name`,
              imo: sql`excluded.imo`,
              flag: sql`excluded.flag`,
              typeCode: sql`excluded.type_code`,
              status: sql`excluded.status`,
              sourceUpdatedAt: sql`excluded.source_updated_at`,
              deletedAt: null,
              updatedAt: sql`now()`,
            },
            setWhere: sql`${vessels.sourceUpdatedAt} < excluded.source_updated_at AND (${vessels.deletedAt} IS NULL OR ${vessels.deletedAt} < excluded.source_updated_at)`,
          })
          .returning({ id: vessels.id });
        return rows.length > 0 ? 'applied' : 'stale';
      });
    } catch (error) {
      if (isUniqueViolation(error, 'vessels_mmsi_key')) return 'mmsi_taken';
      throw error;
    }
  }

  /** Tombstones a deleted vessel (no-op when unknown or already deleted). */
  async markDeleted(
    deleted: Pick<VesselDeletedV1, 'id'>,
    deletedAt: Date,
  ): Promise<void> {
    await this.db
      .update(vessels)
      .set({ deletedAt, updatedAt: sql`now()` })
      .where(and(eq(vessels.id, deleted.id), isNull(vessels.deletedAt)));
  }

  /**
   * Tombstones live vessels absent from a complete stream snapshot that were
   * not projected since the snapshot started.
   *
   * @returns how many vessels were tombstoned.
   */
  async markAbsentDeleted(
    presentIds: readonly string[],
    snapshotStartedAt: Date,
  ): Promise<number> {
    const rows = await this.db
      .update(vessels)
      .set({ deletedAt: snapshotStartedAt, updatedAt: sql`now()` })
      .where(
        and(
          isNull(vessels.deletedAt),
          lt(vessels.updatedAt, snapshotStartedAt),
          sql`NOT (${vessels.id} = ANY (SELECT jsonb_array_elements_text(${JSON.stringify(presentIds)}::jsonb)::uuid))`,
        ),
      )
      .returning({ id: vessels.id });
    return rows.length;
  }
}
