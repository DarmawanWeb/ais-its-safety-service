import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';

import { scopeCondition } from '../../common/tenancy.sql.js';
import type { SafetyReadScope } from '../../common/tenancy.js';
import * as schema from '../../db/schema.js';
import type { EncounterFilter, EncounterSample } from './encounter.js';

const { encounters } = schema;

/** A stored encounter sample. */
export type EncounterRow = typeof encounters.$inferSelect;

/** `encounters` hypertable: samples written by the collision detector, read by the REST API. */
@Injectable()
export class EncountersRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** Inserts samples; a repeated sample (same pair and time) is ignored. */
  async insert(samples: readonly EncounterSample[]): Promise<void> {
    if (samples.length === 0) return;
    await this.db
      .insert(encounters)
      .values(
        samples.map((sample) => ({
          time: sample.time,
          mmsiA: sample.mmsiA,
          mmsiB: sample.mmsiB,
          encounterId: sample.encounterId,
          cpaNm: sample.cpaNm,
          tcpaMin: sample.tcpaMin,
          rangeNm: sample.rangeNm,
          risk: sample.risk,
          positions: sample.positions,
        })),
      )
      .onConflictDoNothing();
  }

  /** Samples matching `filter` that `scope` may read, newest first (`limit` rows). */
  async list(
    filter: EncounterFilter,
    scope: SafetyReadScope,
  ): Promise<EncounterRow[]> {
    const conditions: (SQL | undefined)[] = [
      gte(encounters.time, filter.from),
      lt(encounters.time, filter.to),
      scopeCondition(scope, [encounters.mmsiA, encounters.mmsiB]),
    ];
    if (filter.risks !== undefined)
      conditions.push(inArray(encounters.risk, [...filter.risks]));
    if (filter.mmsi !== undefined)
      conditions.push(
        or(
          eq(encounters.mmsiA, filter.mmsi),
          eq(encounters.mmsiB, filter.mmsi),
        ),
      );
    if (filter.encounterId !== undefined)
      conditions.push(eq(encounters.encounterId, filter.encounterId));
    if (filter.after !== undefined) {
      const { time, mmsiA, mmsiB } = filter.after;
      conditions.push(
        sql`(${encounters.time}, ${encounters.mmsiA}, ${encounters.mmsiB}) < (${time}, ${mmsiA}, ${mmsiB})`,
      );
    }
    return this.db
      .select()
      .from(encounters)
      .where(and(...conditions))
      .orderBy(
        desc(encounters.time),
        desc(encounters.mmsiA),
        desc(encounters.mmsiB),
      )
      .limit(filter.limit);
  }
}
