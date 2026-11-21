import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  type AlertRaisedV1,
  EVENT_TYPES,
  parseEnvelope,
  type SafetyVesselStateV1,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import {
  destinationPoint,
  FleetDirectory,
  makeTestVesselSnapshot,
  makeTestZone,
  toPositionPayload,
  type VesselPosition,
  ZoneIndex,
} from '@darmawanweb/ais-its-nest/analytics';
import { type Database, DRIZZLE_DB } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher, NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { asc, eq, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema.js';
import { startTestService, type TestService } from './support/test-service.js';

// The area of this file: a pipeline along 113.40°E (7.70°S–7.60°S) and a
// crossing about 24 nm east of it.
const ON_LINE = { lat: -7.65, lon: 113.4 };
const PIPELINE = makeTestZone({
  kind: 'pipeline',
  code: 'it-pipeline',
  name: 'Integration pipeline',
  bufferM: 1750,
  geometry: {
    type: 'LineString',
    coordinates: [
      [113.4, -7.7],
      [113.4, -7.6],
    ],
  },
});
const east = (meters: number) => destinationPoint(ON_LINE, 90, meters);
const LAT0 = -7.3;
const LON0 = 113.8;
const place = (x: number, y: number) => ({
  lat: LAT0 + y / 60,
  lon: LON0 + x / (60 * Math.cos((LAT0 * Math.PI) / 180)),
});
const BBOX = '113.3,-7.8,114,-7.2';

const ORG_X = newId();
const ORG_Y = newId();
const ANCHORED = 525_700_001; // org X
const CROSS_A = 525_700_011; // org Y
const CROSS_B = 525_700_012; // not registered
const PAIR_KEY = `collision:${CROSS_A}:${CROSS_B}`;

function position(
  input: Pick<VesselPosition, 'mmsi' | 'lat' | 'lon' | 'time'> &
    Partial<VesselPosition>,
): VesselPosition {
  return {
    source: 'primary',
    sog: 0,
    cog: 0,
    hdg: 511,
    navstatus: 0,
    predictedNavstatus: 0,
    coastDistanceM: null,
    previous: null,
    ...input,
  };
}

describe('safety service end to end (NATS → detectors → SAFETY / ALERTS / tables / REST)', () => {
  let service: TestService;
  let db: Database<typeof schema>;

  const publisher = () => service.app.get(EventPublisher);
  const manager = () => service.app.get(NatsClient).manager;

  async function publishPosition(input: VesselPosition): Promise<void> {
    const { ack } = await publisher().publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      toPositionPayload(input),
    );
    await service.processed('AIS_POSITION', 'safety-positions', ack);
  }

  async function lastAlert(subject: string): Promise<AlertRaisedV1> {
    const message = await manager().streams.getMessage('ALERTS', {
      last_by_subj: subject,
    });
    const parsed = parseEnvelope(message?.data);
    if (!parsed.success || parsed.envelope.type !== EVENT_TYPES.ALERT_RAISED)
      throw new Error(`no alert on ${subject}`);
    return parsed.envelope.data;
  }

  async function count(stream: string, subject: string): Promise<number> {
    const info = await manager().streams.info(stream, {
      subjects_filter: subject,
    });
    return info.state.subjects?.[subject] ?? 0;
  }

  /** Waits for the SAFETY state of a vessel to match `predicate`. */
  async function safetyState(
    mmsi: number,
    predicate: (state: SafetyVesselStateV1) => boolean,
  ): Promise<SafetyVesselStateV1> {
    return waitFor(
      async () => {
        const message = await manager().streams.getMessage('SAFETY', {
          last_by_subj: subjects.safetyState(mmsi),
        });
        const parsed = parseEnvelope(message?.data);
        if (
          parsed.success &&
          parsed.envelope.type === EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED &&
          predicate(parsed.envelope.data)
        )
          return parsed.envelope.data;
        return undefined;
      },
      { timeoutMs: 10_000, message: `SAFETY state of ${mmsi}` },
    );
  }

  const eventsOf = (mmsi: number) =>
    db
      .select()
      .from(schema.events)
      .where(or(eq(schema.events.mmsi, mmsi), eq(schema.events.relatedMmsi, mmsi)))
      .orderBy(asc(schema.events.createdAt));

  beforeAll(async () => {
    service = await startTestService();
    db = service.app.get<unknown, Database<typeof schema>>(DRIZZLE_DB);

    for (const [mmsi, orgId, name] of [
      [ANCHORED, ORG_X, 'KM Jangkar'],
      [CROSS_A, ORG_Y, 'KM Silang'],
    ] as const) {
      const { ack } = await publisher().publishEvent(
        EVENT_TYPES.FLEET_VESSEL_UPSERTED,
        makeTestVesselSnapshot({ mmsi, orgId, name, updatedAt: new Date().toISOString() }),
      );
      await service.processed('FLEET', 'safety-fleet', ack);
    }
    const { ack } = await publisher().publishEvent(
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      PIPELINE,
    );
    await service.processed('GEO', 'safety-zones', ack);
    await waitFor(
      () =>
        service.app.get(ZoneIndex).has(PIPELINE.id) &&
        service.app.get(FleetDirectory).byMmsi(CROSS_A) !== undefined,
    );
  });

  afterAll(async () => {
    await publisher().publishEvent(EVENT_TYPES.GEO_ZONE_DELETED, {
      id: PIPELINE.id,
      orgId: null,
    });
    await service.app.close();
  });

  it('projects the GEO and FLEET streams into the zones and vessels tables', async () => {
    const [zone] = await db
      .select()
      .from(schema.zones)
      .where(eq(schema.zones.id, PIPELINE.id));
    expect(zone).toMatchObject({ kind: 'pipeline', code: 'it-pipeline', deletedAt: null });
    const vessels = await db
      .select()
      .from(schema.vessels)
      .where(eq(schema.vessels.mmsi, ANCHORED));
    expect(vessels).toEqual([expect.objectContaining({ orgId: ORG_X, name: 'KM Jangkar' })]);
  });

  it('EWS: warning, escalation to danger, no repeats while unchanged, resolution when safe', async () => {
    const t0 = Date.now() - 60_000;
    const anchored = { navstatus: 1, predictedNavstatus: 1 as const, sog: 0.1, cog: 15 };
    const subject = subjects.alert('ews', ANCHORED);

    // 1. Predicted at anchor 1 000 m from the pipeline → warning.
    await publishPosition(position({ mmsi: ANCHORED, ...east(1000), ...anchored, time: new Date(t0) }));
    const warning = await waitFor(() => lastAlert(subject));
    expect(warning).toMatchObject({
      type: 'ews',
      domain: 'safety',
      severity: 'warning',
      mmsi: ANCHORED,
      zoneId: PIPELINE.id,
      dedupKey: `ews:${ANCHORED}:${PIPELINE.id}`,
      methodId: 'ews.pipeline_distance_status',
      data: {
        methodId: 'ews.pipeline_distance_status',
        zoneId: PIPELINE.id,
        thresholds: { dangerM: 500, warningM: 1750 },
        ewsStatus: 1,
      },
    });
    expect(warning.data.pipelineDistanceM).toBeCloseTo(1000, 3);
    const warned = await safetyState(ANCHORED, (state) => state.ewsStatus === 1);
    expect(warned).toMatchObject({
      nearestPipelineZoneId: PIPELINE.id,
      collisionRisk: 'none',
      methodIds: ['ews.pipeline_distance_status', 'collision.cpa_tcpa'],
    });
    expect(warned.pipelineDistanceM).toBeCloseTo(1000, 3);

    // 2. 300 m → danger: escalated (a new critical alert, same key).
    await publishPosition(position({ mmsi: ANCHORED, ...east(300), ...anchored, time: new Date(t0 + 10_000) }));
    await waitFor(async () => (await lastAlert(subject)).severity === 'critical');
    await safetyState(ANCHORED, (state) => state.ewsStatus === 0);

    // 3. Still in danger → nothing new is published.
    await publishPosition(position({ mmsi: ANCHORED, ...east(310), ...anchored, time: new Date(t0 + 20_000) }));
    expect(await count('ALERTS', subject)).toBe(2);

    // 4. Under way again → safe → the occurrence is resolved.
    await publishPosition(
      position({ mmsi: ANCHORED, ...east(320), navstatus: 0, predictedNavstatus: 0, sog: 7, cog: 90, time: new Date(t0 + 30_000) }),
    );
    await safetyState(ANCHORED, (state) => state.ewsStatus === 3);
    const rows = await waitFor(async () => {
      const events = await eventsOf(ANCHORED);
      return events.every((event) => event.status === 'resolved') ? events : undefined;
    });
    expect(rows.map((row) => [row.detector, row.severity, row.resolution?.['reason']])).toEqual([
      ['ews', 'warning', 'escalated'],
      ['ews', 'critical', 'safe: not at anchor within the warning distance'],
    ]);
    expect(await count('ALERTS', subject)).toBe(2);
  });

  it('collision: a crossing raises warning then critical, resolves after passing, stores the encounter', async () => {
    // Reports every minute; both vessels reach (0, 2) nm at minute 10.
    const t0 = Date.now() - 13 * 60_000;
    for (let minute = 0; minute <= 12; minute += 1) {
      const time = t0 + minute * 60_000;
      await publishPosition(
        position({ mmsi: CROSS_A, ...place(0, minute / 5), sog: 12, cog: 0, time: new Date(time) }),
      );
      await publishPosition(
        position({ mmsi: CROSS_B, ...place(2 - minute / 5, 2), sog: 12, cog: 270, time: new Date(time + 1000) }),
      );
    }
    const subject = subjects.alert('collision', CROSS_A);
    expect(await count('ALERTS', subject)).toBe(2);
    expect(await lastAlert(subject)).toMatchObject({
      type: 'collision',
      severity: 'critical',
      mmsi: CROSS_A,
      relatedMmsi: CROSS_B,
      dedupKey: PAIR_KEY,
      methodId: 'collision.cpa_tcpa',
      data: { methodId: 'collision.cpa_tcpa', risk: 'high' },
    });

    const rows = await waitFor(async () => {
      const events = await eventsOf(CROSS_B);
      return events.length === 2 && events.every((event) => event.status === 'resolved')
        ? events
        : undefined;
    });
    expect(rows.map((row) => [row.detector, row.severity, row.dedupKey])).toEqual([
      ['collision', 'warning', PAIR_KEY],
      ['collision', 'critical', PAIR_KEY],
    ]);
    expect(rows[1]?.resolution?.['reason']).toMatch(/^risk none/);

    for (const mmsi of [CROSS_A, CROSS_B])
      await safetyState(mmsi, (state) => state.collisionRisk === 'none' && state.closestEncounter === null);

    const samples = await db
      .select()
      .from(schema.encounters)
      .where(eq(schema.encounters.mmsiA, CROSS_A))
      .orderBy(asc(schema.encounters.time));
    expect(new Set(samples.map((sample) => sample.encounterId)).size).toBe(1);
    expect(samples[0]?.risk).toBe('medium');
    expect(samples.map((sample) => sample.risk)).toContain('high');
    expect(samples.at(-1)?.risk).toBe('none');
    expect(samples[0]?.positions.a.mmsi).toBe(CROSS_A);
  });

  describe('REST API (tenancy spec §8.5)', () => {
    const get = async (url: string, claims: Parameters<TestService['authorization']>[0]) =>
      service.app.inject({ method: 'GET', url, headers: await service.authorization(claims) });
    const viewerX = { roles: ['viewer'] as const, orgId: ORG_X };
    const viewerY = { roles: ['viewer'] as const, orgId: ORG_Y };
    const authority = { roles: ['authority'] as const, orgId: newId() };

    it('lists the latest safety states of a viewport for every tenant', async () => {
      const response = await get(`/api/v2/safety/vessels?bbox=${BBOX}`, viewerY);
      expect(response.statusCode).toBe(200);
      const states = response.json<{ mmsi: number }[]>();
      expect(states.map((state) => state.mmsi)).toEqual(
        expect.arrayContaining([ANCHORED, CROSS_A, CROSS_B]),
      );
      const anchored = await get(`/api/v2/safety/vessels/${ANCHORED}`, viewerY);
      expect(anchored.statusCode).toBe(200);
      expect(anchored.json()).toMatchObject({
        mmsi: ANCHORED,
        ewsStatus: 3,
        collisionRisk: 'none',
        nearestPipelineZoneId: PIPELINE.id,
        vessel: { name: 'KM Jangkar' },
        predictedNavstatus: 0,
      });

      const atRisk = await get(`/api/v2/safety/vessels?bbox=${BBOX}&ewsStatus=0,1`, viewerY);
      expect(atRisk.json<{ mmsi: number }[]>().map((state) => state.mmsi)).not.toContain(ANCHORED);

      const missing = await get('/api/v2/safety/vessels/999999999', viewerY);
      expect(missing.statusCode).toBe(404);
      expect(missing.headers['content-type']).toContain('application/problem+json');
      expect(missing.json()).toMatchObject({ code: 'SAFETY_STATE_NOT_FOUND' });
    });

    it('scopes events to the vessels of the organization, authority sees all', async () => {
      type Page = { data: { id: string; mmsi: number; detector: string }[]; page: { nextCursor: string | null } };
      const ewsFor = async (claims: Parameters<TestService['authorization']>[0]) =>
        (await get(`/api/v2/safety/events?mmsi=${ANCHORED}`, claims)).json<Page>().data;
      expect(await ewsFor(viewerX)).toHaveLength(2);
      expect(await ewsFor(authority)).toHaveLength(2);
      expect(await ewsFor(viewerY)).toHaveLength(0);
      expect(await ewsFor({ roles: ['viewer'], orgId: null })).toHaveLength(0);

      // CROSS_B is unregistered: its collision events belong to org Y through CROSS_A.
      const collision = (await get(`/api/v2/safety/events?detector=collision&mmsi=${CROSS_B}`, viewerY)).json<Page>();
      expect(collision.data.map((event) => event.detector)).toEqual(['collision', 'collision']);
      expect((await get(`/api/v2/safety/events?detector=collision&mmsi=${CROSS_B}`, viewerX)).json<Page>().data).toEqual([]);

      const first = (await get(`/api/v2/safety/events?mmsi=${ANCHORED}&limit=1`, viewerX)).json<Page>();
      expect(first.data).toHaveLength(1);
      expect(first.page.nextCursor).not.toBeNull();
      const second = (
        await get(`/api/v2/safety/events?mmsi=${ANCHORED}&limit=1&cursor=${first.page.nextCursor ?? ''}`, viewerX)
      ).json<Page>();
      expect(second.data.map((event) => event.id)).not.toEqual(first.data.map((event) => event.id));

      const id = first.data[0]?.id ?? '';
      expect((await get(`/api/v2/safety/events/${id}`, viewerX)).statusCode).toBe(200);
      const hidden = await get(`/api/v2/safety/events/${id}`, viewerY);
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json()).toMatchObject({ code: 'SAFETY_EVENT_NOT_FOUND' });

      const invalid = await get('/api/v2/safety/events?severity=bogus', authority);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('serves the encounter history to the tenants of the pair', async () => {
      type Page = { data: { encounterId: string; risk: string; mmsiA: number }[] };
      const mine = (await get(`/api/v2/safety/encounters?mmsi=${CROSS_A}&from=${new Date(Date.now() - 3_600_000).toISOString()}`, viewerY)).json<Page>();
      expect(mine.data.length).toBeGreaterThan(2);
      expect(mine.data.every((sample) => sample.mmsiA === CROSS_A)).toBe(true);
      const high = (await get(`/api/v2/safety/encounters?mmsi=${CROSS_A}&risk=high`, authority)).json<Page>();
      expect(high.data.length).toBeGreaterThan(0);
      expect(high.data.every((sample) => sample.risk === 'high')).toBe(true);
      expect((await get(`/api/v2/safety/encounters?mmsi=${CROSS_A}`, viewerX)).json<Page>().data).toEqual([]);
    });

    it('lists the detectors with their method ids and thresholds', async () => {
      const response = await get('/api/v2/safety/detectors', viewerX);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({
          id: 'ews',
          enabled: true,
          methodIds: ['ews.pipeline_distance_status'],
          config: { DANGER_M: 500, WARNING_M: 1750 },
        }),
        expect.objectContaining({
          id: 'collision',
          enabled: true,
          methodIds: ['collision.cpa_tcpa'],
          config: expect.objectContaining({ SEARCH_RADIUS_NM: 6, HIGH_CPA_NM: 0.25 }) as unknown,
        }),
      ]);
    });

    it('requires safety:read', async () => {
      expect((await service.app.inject({ method: 'GET', url: '/api/v2/safety/vessels' })).statusCode).toBe(401);
      expect((await get('/api/v2/safety/vessels', { roles: [] })).statusCode).toBe(403);
    });
  });
});
