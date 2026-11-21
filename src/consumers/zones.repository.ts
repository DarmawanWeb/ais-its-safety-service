import type { ZoneSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import {
  type Database,
  geoJsonToGeography,
  InjectDb,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import * as schema from '../db/schema.js';

const { zones } = schema;

/** Projection of the `GEO` stream: zones by id, newest snapshot wins, deletions tombstoned. */
@Injectable()
export class ZonesRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /**
   * Applies a snapshot when it is newer than the stored one (and than its
   * tombstone). Idempotent.
   *
   * @returns `true` when the row changed.
   */
  async upsert(zone: ZoneSnapshotV1): Promise<boolean> {
    const updatedAt = new Date(zone.updatedAt);
    const rows = await this.db
      .insert(zones)
      .values({
        id: zone.id,
        orgId: zone.orgId,
        code: zone.code,
        name: zone.name,
        kind: zone.kind,
        geom: geoJsonToGeography(zone.geometry),
        bufferM: zone.bufferM,
        active: zone.active,
        alertOnEnter: zone.alertOnEnter,
        properties: zone.properties,
        sourceUpdatedAt: updatedAt,
      })
      .onConflictDoUpdate({
        target: zones.id,
        set: {
          orgId: sql`excluded.org_id`,
          code: sql`excluded.code`,
          name: sql`excluded.name`,
          kind: sql`excluded.kind`,
          geom: sql`excluded.geom`,
          bufferM: sql`excluded.buffer_m`,
          active: sql`excluded.active`,
          alertOnEnter: sql`excluded.alert_on_enter`,
          properties: sql`excluded.properties`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          deletedAt: null,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${zones.sourceUpdatedAt} < excluded.source_updated_at AND (${zones.deletedAt} IS NULL OR ${zones.deletedAt} < excluded.source_updated_at)`,
      })
      .returning({ id: zones.id });
    return rows.length > 0;
  }

  /** Tombstones a deleted zone (no-op when unknown or already deleted). */
  async markDeleted(id: string, deletedAt: Date): Promise<void> {
    await this.db
      .update(zones)
      .set({ deletedAt, updatedAt: sql`now()` })
      .where(and(eq(zones.id, id), isNull(zones.deletedAt)));
  }

  /**
   * Tombstones live zones absent from a complete stream snapshot. Only rows
   * not projected since the snapshot started are touched, so a zone the
   * durable consumer added meanwhile survives.
   *
   * @returns how many zones were tombstoned.
   */
  async markAbsentDeleted(
    presentIds: readonly string[],
    snapshotStartedAt: Date,
  ): Promise<number> {
    const rows = await this.db
      .update(zones)
      .set({ deletedAt: snapshotStartedAt, updatedAt: sql`now()` })
      .where(
        and(
          isNull(zones.deletedAt),
          lt(zones.updatedAt, snapshotStartedAt),
          sql`NOT (${zones.id} = ANY (SELECT jsonb_array_elements_text(${JSON.stringify(presentIds)}::jsonb)::uuid))`,
        ),
      )
      .returning({ id: zones.id });
    return rows.length;
  }
}
