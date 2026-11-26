import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { PG_POOL } from '@darmawanweb/ais-its-nest/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VesselStatesRepository } from '../src/modules/vessel-states/vessel-states.repository.js';
import { startTestService, type TestService } from './support/test-service.js';

// The area of this file: states seeded around 5.5°N 97.5°E (no other test file
// goes north of the equator), the plan check's bulk states around 11°N 91°E.
const BBOX = '97.4,5.4,97.6,5.6';
const HOUR_MS = 3_600_000;
const ORG_X = newId();
const ORG_Y = newId();

interface Seed {
  readonly mmsi: number;
  readonly ews: 0 | 1 | 3;
  readonly risk: 'none' | 'low' | 'medium' | 'high';
  /** Age of the latest position (default 10 min). */
  readonly ageMs?: number;
  readonly lat?: number;
  /** Owner of the nearest pipeline zone (an org-owned zone, spec §8.5). */
  readonly pipelineOrgId?: string;
}

const SEEDS: readonly Seed[] = [
  { mmsi: 525_990_001, ews: 0, risk: 'none' },
  { mmsi: 525_990_002, ews: 0, risk: 'low' },
  { mmsi: 525_990_003, ews: 1, risk: 'medium' },
  // Warned by a pipeline private to organization X: counted for every reader.
  { mmsi: 525_990_004, ews: 1, risk: 'none', pipelineOrgId: ORG_X },
  { mmsi: 525_990_005, ews: 3, risk: 'high' },
  { mmsi: 525_990_006, ews: 3, risk: 'medium' },
  { mmsi: 525_990_007, ews: 3, risk: 'low' },
  { mmsi: 525_990_008, ews: 3, risk: 'none' },
  // Last position 25 h ago: outside the default window of 24 h.
  { mmsi: 525_990_009, ews: 0, risk: 'high', ageMs: 25 * HOUR_MS },
  // Outside the bbox.
  { mmsi: 525_990_010, ews: 0, risk: 'high', lat: 5.8 },
];
const SEEDED = SEEDS.map((seed) => seed.mmsi);
const BULK_FIRST = 526_000_000;
const BULK_COUNT = 20_000;

interface Stats {
  ews: { danger: number; warning: number; methodId: string };
  collision: { high: number; medium: number; methodId: string };
  since: string;
  at: string;
}

describe('GET /safety/stats (counts of the vessels at risk)', () => {
  let service: TestService;
  let pool: Pool;
  const get = async (
    url: string,
    claims: Parameters<TestService['authorization']>[0] = {
      roles: ['viewer'],
      orgId: ORG_Y,
    },
  ) =>
    service.app.inject({
      method: 'GET',
      url,
      headers: await service.authorization(claims),
    });
  const stats = async (
    query: string,
    claims?: Parameters<TestService['authorization']>[0],
  ): Promise<Stats> => {
    const response = await get(`/api/v2/safety/stats?${query}`, claims);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<Stats>();
  };

  beforeAll(async () => {
    service = await startTestService();
    pool = service.app.get<unknown, Pool>(PG_POOL);
    const now = Date.now();
    await pool.query(
      `INSERT INTO vessel_state (mmsi, time, geom, sog, cog, hdg, navstatus, pred_navstatus,
         ews_status, pipeline_dist_m, nearest_pipeline_zone_id, nearest_pipeline_org_id,
         ews_evaluated_at, collision_risk, collision_evaluated_at, evaluated_at)
       SELECT r.mmsi, r.time, ST_SetSRID(ST_MakePoint(97.5, r.lat), 4326)::geography,
         0, 0, 511, 1, 1, r.ews,
         CASE WHEN r.org IS NULL THEN NULL ELSE 900 END,
         CASE WHEN r.org IS NULL THEN NULL ELSE gen_random_uuid() END,
         r.org, r.time, r.risk, r.time, r.time
       FROM unnest($1::integer[], $2::timestamptz[], $3::float8[], $4::smallint[], $5::text[],
                   $6::uuid[]) AS r(mmsi, time, lat, ews, risk, org)`,
      [
        SEEDED,
        SEEDS.map((seed) => new Date(now - (seed.ageMs ?? 600_000))),
        SEEDS.map((seed) => seed.lat ?? 5.5),
        SEEDS.map((seed) => seed.ews),
        SEEDS.map((seed) => seed.risk),
        SEEDS.map((seed) => seed.pipelineOrgId ?? null),
      ],
    );
  });

  afterAll(async () => {
    await pool.query(
      'DELETE FROM vessel_state WHERE mmsi = ANY($1::integer[]) OR mmsi BETWEEN $2 AND $3',
      [SEEDED, BULK_FIRST, BULK_FIRST + BULK_COUNT - 1],
    );
    await service.app.close();
  });

  it('counts the alerting EWS statuses and collision bands of a viewport (last 24 h by default)', async () => {
    const before = Date.now();
    const body = await stats(`bbox=${BBOX}`);
    expect(body).toEqual({
      ews: { danger: 2, warning: 2, methodId: 'ews.pipeline_distance_status' },
      collision: { high: 1, medium: 2, methodId: 'collision.cpa_tcpa' },
      since: expect.any(String) as unknown,
      at: expect.any(String) as unknown,
    });
    const at = Date.parse(body.at);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(Date.parse(body.since)).toBe(at - 24 * HOUR_MS);

    const since = new Date(Date.now() - 26 * HOUR_MS).toISOString();
    expect(
      await stats(`bbox=${BBOX}&since=${encodeURIComponent(since)}`),
    ).toMatchObject({
      ews: { danger: 3, warning: 2 },
      collision: { high: 2, medium: 2 },
      since,
    });

    // Without a bbox: every vessel of the window (other files' states included).
    const all = await stats('');
    expect(all.ews.danger).toBeGreaterThanOrEqual(3);
    expect(all.collision.high).toBeGreaterThanOrEqual(2);
  });

  it('counts what GET /safety/vessels lists for the same window, without its limit', async () => {
    const listed = async (filter: string) => {
      const response = await get(
        `/api/v2/safety/vessels?bbox=${BBOX}&${filter}`,
      );
      expect(response.statusCode).toBe(200);
      return response.json<unknown[]>().length;
    };
    const body = await stats(`bbox=${BBOX}`);
    expect({
      ews: {
        danger: await listed('ewsStatus=0'),
        warning: await listed('ewsStatus=1'),
      },
      collision: {
        high: await listed('collisionRisk=high'),
        medium: await listed('collisionRisk=medium'),
      },
    }).toEqual({
      ews: { danger: body.ews.danger, warning: body.ews.warning },
      collision: { high: body.collision.high, medium: body.collision.medium },
    });
  });

  it('gives every reader with safety:read the same counts (states are shared, spec §8.5)', async () => {
    // The five roles with safety:read (spec §8.4), in and outside organization X.
    const readers = [
      { roles: ['viewer'], orgId: ORG_X },
      { roles: ['viewer'], orgId: ORG_Y },
      { roles: ['fleet_manager'], orgId: newId() },
      { roles: ['org_admin'], orgId: ORG_Y },
      { roles: ['authority'], orgId: newId() },
      { roles: ['super_admin'], orgId: null },
      { roles: ['viewer'], orgId: null },
    ] as const;
    const counts = await Promise.all(
      readers.map(async (claims) => {
        const { ews, collision } = await stats(`bbox=${BBOX}`, claims);
        return { ews, collision };
      }),
    );
    for (const count of counts) expect(count).toEqual(counts[0]);
    // The vessel warned by organization X's private pipeline counts for Y, whose list hides the zone.
    const warned = await get('/api/v2/safety/vessels/525990004');
    expect(warned.json()).toMatchObject({
      ewsStatus: 1,
      nearestPipelineZoneId: null,
      pipelineDistanceM: null,
    });
  });

  it('validates the query like GET /safety/vessels and requires safety:read', async () => {
    const refused = async (url: string, field: string) => {
      const response = await get(url);
      expect(response.statusCode, url).toBe(400);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.json()).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: expect.arrayContaining([
          expect.objectContaining({ field }),
        ]) as unknown,
      });
    };
    for (const [query, field] of [
      ['bbox=97.4,5.4,97.6', 'bbox'],
      ['since=yesterday', 'since'],
      ['limit=10', 'limit'],
      ['ewsStatus=0', 'ewsStatus'],
    ] as const)
      await refused(`/api/v2/safety/stats?${query}`, field);
    // ISO-8601 forms that Date cannot read (hour only, week date, basic
    // format, comma fraction, signed year): 400 on both routes, never 500.
    for (const since of [
      '2026-11-23T10',
      '2026-W48',
      '20261122',
      '2026-11-23T10:00:00,5Z',
      '-2026-11-22T00:00:00Z',
    ])
      for (const route of ['stats', 'vessels'])
        await refused(
          `/api/v2/safety/${route}?since=${encodeURIComponent(since)}`,
          'since',
        );
    expect(
      (await service.app.inject({ method: 'GET', url: '/api/v2/safety/stats' }))
        .statusCode,
    ).toBe(401);
    expect((await get('/api/v2/safety/stats', { roles: [] })).statusCode).toBe(
      403,
    );
  });

  it('reads the partial index of the states at risk, not every state', async () => {
    // 20 000 states, 1 % in EWS warning or danger, 0.8 % in a high or medium band.
    await pool.query(
      `INSERT INTO vessel_state (mmsi, time, geom, sog, cog, hdg, navstatus, pred_navstatus,
         ews_status, collision_risk, evaluated_at)
       SELECT $1::integer + i, now() - (i % 600) * interval '1 minute',
         ST_SetSRID(ST_MakePoint(90 + (i % 200) * 0.01, 10 + (i / 200) * 0.01), 4326)::geography,
         10, 90, 511, 0, 0,
         CASE i % 200 WHEN 0 THEN 0 WHEN 1 THEN 1 ELSE 3 END,
         CASE WHEN i % 250 = 7 THEN 'high' WHEN i % 250 = 8 THEN 'medium'
              WHEN i % 100 = 9 THEN 'low' ELSE 'none' END,
         now()
       FROM generate_series(0, $2::integer - 1) AS i`,
      [BULK_FIRST, BULK_COUNT],
    );
    await pool.query('ANALYZE vessel_state');
    const nodes = async (window: { since: Date }): Promise<PlanNode[]> => {
      const query = service.app
        .get(VesselStatesRepository)
        .countAtRiskQuery(window)
        .toSQL();
      const { rows } = await pool.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
        `EXPLAIN (FORMAT JSON) ${query.sql}`,
        query.params,
      );
      return flatten(rows[0]?.['QUERY PLAN'][0].Plan);
    };
    const plan = await nodes({ since: new Date(Date.now() - 24 * HOUR_MS) });
    expect(plan.map((node) => node['Index Name'])).toContain(
      'vessel_state_at_risk_idx',
    );
    expect(plan.map((node) => node['Node Type'])).not.toContain('Seq Scan');

    const bulk = await stats('bbox=89.9,9.9,92.1,11.1');
    expect(bulk).toMatchObject({
      ews: { danger: 100, warning: 100 },
      collision: { high: 80, medium: 80 },
    });
  });
});

/** A node of a JSON query plan. */
interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Index Name'?: string;
  readonly Plans?: readonly PlanNode[];
}

/** Every node of a plan, depth first. */
function flatten(node: PlanNode | undefined): PlanNode[] {
  return node === undefined
    ? []
    : [node, ...(node.Plans ?? []).flatMap((child) => flatten(child))];
}
