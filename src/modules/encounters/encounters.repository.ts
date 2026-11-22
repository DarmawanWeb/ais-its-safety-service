import {
  COLLISION_RISKS,
  type CollisionRisk,
} from '@darmawanweb/ais-its-contracts/domain';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
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
import type {
  EncounterFilter,
  EncounterHistorySample,
  EncounterRecord,
  EncounterSample,
} from './encounter.js';

const { encounters } = schema;

/** Rank of a band (`none` 0 … `high` 3), the order of contracts `COLLISION_RISKS`. */
const riskRank = (risk: CollisionRisk): number => COLLISION_RISKS.indexOf(risk);

/** SQL rank of the `risk` column, same order as {@link riskRank}. */
const RISK_RANK_SQL = sql`CASE ${encounters.risk} ${sql.join(
  COLLISION_RISKS.map(
    (risk) => sql`WHEN ${risk} THEN ${sql.raw(String(riskRank(risk)))}`,
  ),
  sql` `,
)} END`;

const PEAK_RANK = sql<number>`max(${RISK_RANK_SQL})`;
const LAST_SAMPLE_AT = sql`max(${encounters.time})`;

/** The band of a rank computed by {@link RISK_RANK_SQL}. */
function riskOfRank(rank: number): CollisionRisk {
  return COLLISION_RISKS[rank] ?? 'none';
}

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

  /**
   * Encounters with samples in the filter's range that `scope` may read,
   * latest sample first (`limit` encounters), each with its samples in the
   * range. Two statements: the encounters (grouped samples), then their
   * history.
   */
  async list(
    filter: EncounterFilter,
    scope: SafetyReadScope,
  ): Promise<EncounterRecord[]> {
    const inRange = and(
      gte(encounters.time, filter.from),
      lt(encounters.time, filter.to),
    );
    const conditions: (SQL | undefined)[] = [
      inRange,
      scopeCondition(scope, [encounters.mmsiA, encounters.mmsiB]),
    ];
    if (filter.mmsi !== undefined)
      conditions.push(
        or(
          eq(encounters.mmsiA, filter.mmsi),
          eq(encounters.mmsiB, filter.mmsi),
        ),
      );
    if (filter.encounterId !== undefined)
      conditions.push(eq(encounters.encounterId, filter.encounterId));
    const having: SQL[] = [];
    if (filter.peakRisks !== undefined)
      having.push(inArray(PEAK_RANK, filter.peakRisks.map(riskRank)));
    if (filter.after !== undefined)
      having.push(
        sql`(${LAST_SAMPLE_AT}, ${encounters.encounterId}) < (${filter.after.lastSampleAt}, ${filter.after.encounterId})`,
      );

    const groups = await this.db
      .select({
        encounterId: encounters.encounterId,
        mmsiA: encounters.mmsiA,
        mmsiB: encounters.mmsiB,
        startedAt: sql`min(${encounters.time})`.mapWith(encounters.time),
        lastSampleAt: LAST_SAMPLE_AT.mapWith(encounters.time),
        peakRank: PEAK_RANK.mapWith(Number),
        minCpaNm: sql`min(${encounters.cpaNm})`.mapWith(Number),
      })
      .from(encounters)
      .where(and(...conditions))
      .groupBy(encounters.encounterId, encounters.mmsiA, encounters.mmsiB)
      .having(having.length === 0 ? undefined : and(...having))
      .orderBy(desc(LAST_SAMPLE_AT), desc(encounters.encounterId))
      .limit(filter.limit);
    if (groups.length === 0) return [];

    const samples = await this.db
      .select()
      .from(encounters)
      .where(
        and(
          inRange,
          inArray(
            encounters.encounterId,
            groups.map((group) => group.encounterId),
          ),
        ),
      )
      .orderBy(asc(encounters.time));
    const history = new Map<string, EncounterHistorySample[]>();
    for (const sample of samples) {
      const list = history.get(sample.encounterId) ?? [];
      list.push({
        time: sample.time,
        cpaNm: sample.cpaNm,
        tcpaMin: sample.tcpaMin,
        rangeNm: sample.rangeNm,
        risk: sample.risk,
        positions: sample.positions,
      });
      history.set(sample.encounterId, list);
    }
    return groups.map((group) => ({
      encounterId: group.encounterId,
      mmsiA: group.mmsiA,
      mmsiB: group.mmsiB,
      startedAt: group.startedAt,
      lastSampleAt: group.lastSampleAt,
      peakRisk: riskOfRank(group.peakRank),
      minCpaNm: group.minCpaNm,
      history: history.get(group.encounterId) ?? [],
    }));
  }
}
