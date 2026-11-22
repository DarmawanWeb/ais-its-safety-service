import {
  EVENT_TYPES,
  parseEnvelope,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import {
  destinationPoint,
  makeTestZone,
  toPositionPayload,
  type VesselPosition,
  VesselStateStore,
  ZoneIndex,
} from '@darmawanweb/ais-its-nest/analytics';
import { type Database, DRIZZLE_DB } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher, NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { uniqueName, waitFor } from '@darmawanweb/ais-its-nest/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema.js';
import { startTestService, type TestService } from './support/test-service.js';

// A pipeline along 108.40°E (3.55°S–3.45°S), away from the other test files.
const ON_LINE = { lat: -3.5, lon: 108.4 };
const PIPELINE = makeTestZone({
  kind: 'pipeline',
  code: 'failover-pipeline',
  name: 'Failover pipeline',
  bufferM: 1750,
  geometry: {
    type: 'LineString',
    coordinates: [
      [108.4, -3.55],
      [108.4, -3.45],
    ],
  },
});
const WARNING_AT = destinationPoint(ON_LINE, 90, 1000);
const RESOLVED_ELSEWHERE = 525_810_001; // A resolved it after B booted
const RAISED_ELSEWHERE = 525_810_002; // A raised it after B booted
const PROBE = 525_810_009;

function position(
  mmsi: number,
  time: Date,
  anchored: boolean,
  offsetDeg = 0,
): VesselPosition {
  return {
    mmsi,
    time,
    source: 'primary',
    lat: WARNING_AT.lat + offsetDeg,
    lon: WARNING_AT.lon,
    sog: anchored ? 0.1 : 7,
    cog: anchored ? 0 : 90,
    hdg: 511,
    navstatus: anchored ? 1 : 0,
    predictedNavstatus: anchored ? 1 : 0,
    coastDistanceM: null,
    previous: null,
  };
}

/**
 * Review finding (high): a standby that takes over must neither raise again
 * what the previous instance raised after the standby booted, nor ignore
 * what that instance resolved meanwhile (`AlertStateSync`).
 */
describe('failover between two instances of one durable (exclusive consumer)', () => {
  const durablePrefix = `${uniqueName('ha')}-`;
  const env = { DETECTOR_PINNED_TTL_MS: '3000', ALERT_COOLDOWN_S: '0' };
  let a: TestService;
  let b: TestService | undefined;
  let aClosed = false;
  let db: Database<typeof schema>;

  const alerts = async (service: TestService, mmsi: number) => {
    const subject = subjects.alert('ews', mmsi);
    const info = await service.app
      .get(NatsClient)
      .manager.streams.info('ALERTS', { subjects_filter: subject });
    return info.state.subjects?.[subject] ?? 0;
  };
  const rows = (mmsi: number) =>
    db
      .select()
      .from(schema.events)
      .where(eq(schema.events.mmsi, mmsi))
      .orderBy(asc(schema.events.createdAt));
  const publish = async (service: TestService, input: VesselPosition) => {
    const { ack } = await service.app
      .get(EventPublisher)
      .publishEvent(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        toPositionPayload(input),
      );
    return ack;
  };

  beforeAll(async () => {
    a = await startTestService({ durablePrefix, env });
    const { ack } = await a.app
      .get(EventPublisher)
      .publishEvent(EVENT_TYPES.GEO_ZONE_UPSERTED, PIPELINE);
    await a.processed('GEO', 'safety-zones', ack);
    await waitFor(() => a.app.get(ZoneIndex).has(PIPELINE.id));
  });

  afterAll(async () => {
    const open = [...(aClosed ? [] : [a]), ...(b === undefined ? [] : [b])];
    await open[0]?.app
      .get(EventPublisher)
      .publishEvent(EVENT_TYPES.GEO_ZONE_DELETED, {
        id: PIPELINE.id,
        orgId: null,
      });
    for (const service of open) await service.app.close();
  });

  it('takes over with the alert state of the previous instance', async () => {
    const t0 = Date.now() - 120_000;
    // A is the active instance: it handles the first position.
    await a.processed(
      'AIS_POSITION',
      'safety-positions',
      await publish(a, position(RESOLVED_ELSEWHERE, new Date(t0), true)),
    );
    expect(a.app.get(VesselStateStore).get(RESOLVED_ELSEWHERE)).toBeDefined();
    await waitFor(async () =>
      (await alerts(a, RESOLVED_ELSEWHERE)) === 1 ? true : undefined,
    );

    // B boots as the standby and restores that open alert.
    const standby = await startTestService({ durablePrefix, env });
    b = standby;
    // A closes its pool when it stops: read the table through B.
    db = standby.app.get<unknown, Database<typeof schema>>(DRIZZLE_DB);
    await waitFor(() => standby.app.get(ZoneIndex).has(PIPELINE.id));

    // A resolves the first condition and raises a second one; B sees neither.
    await a.processed(
      'AIS_POSITION',
      'safety-positions',
      await publish(
        a,
        position(RESOLVED_ELSEWHERE, new Date(t0 + 10_000), false),
      ),
    );
    await a.processed(
      'AIS_POSITION',
      'safety-positions',
      await publish(a, position(RAISED_ELSEWHERE, new Date(t0 + 10_000), true)),
    );
    expect(
      standby.app.get(VesselStateStore).get(RAISED_ELSEWHERE),
    ).toBeUndefined();
    await waitFor(async () =>
      (await alerts(a, RAISED_ELSEWHERE)) === 1 ? true : undefined,
    );

    // A stops; B is pinned once A's pinned TTL (3 s) expired.
    await a.app.close();
    aClosed = true;
    const probe = await publish(
      standby,
      position(PROBE, new Date(t0 + 20_000), false),
    );
    await waitFor(
      () => standby.app.get(VesselStateStore).get(PROBE) !== undefined,
      {
        timeoutMs: 60_000,
        message: 'B took over',
      },
    );
    await standby.processed('AIS_POSITION', 'safety-positions', probe);

    // Both conditions again, on B.
    for (const mmsi of [RESOLVED_ELSEWHERE, RAISED_ELSEWHERE])
      await standby.processed(
        'AIS_POSITION',
        'safety-positions',
        await publish(
          standby,
          position(mmsi, new Date(t0 + 30_000), true, 0.00001),
        ),
      );

    // Resolved elsewhere → raised again (it was missed before the fix).
    expect(await alerts(standby, RESOLVED_ELSEWHERE)).toBe(2);
    expect((await rows(RESOLVED_ELSEWHERE)).map((row) => row.status)).toEqual([
      'resolved',
      'open',
    ]);
    // Raised elsewhere → not raised again, one open row (two before the fix).
    expect(await alerts(standby, RAISED_ELSEWHERE)).toBe(1);
    expect((await rows(RAISED_ELSEWHERE)).map((row) => row.status)).toEqual([
      'open',
    ]);

    // Under way again: B resolves the occurrence A raised.
    await standby.processed(
      'AIS_POSITION',
      'safety-positions',
      await publish(
        standby,
        position(RAISED_ELSEWHERE, new Date(t0 + 40_000), false),
      ),
    );
    expect((await rows(RAISED_ELSEWHERE)).map((row) => row.status)).toEqual([
      'resolved',
    ]);

    const message = await standby.app
      .get(NatsClient)
      .manager.streams.getMessage('ALERTS', {
        last_by_subj: subjects.alert('ews', RESOLVED_ELSEWHERE),
      });
    const parsed = parseEnvelope(message?.data);
    expect(parsed.success && parsed.envelope.type).toBe(
      EVENT_TYPES.ALERT_RAISED,
    );
  });
});
