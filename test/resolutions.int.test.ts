import {
  type AlertRaisedV1,
  EVENT_TYPES,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import {
  AlertEmitter,
  destinationPoint,
  makeTestZone,
  toPositionPayload,
  ZoneIndex,
} from '@darmawanweb/ais-its-nest/analytics';
import { type Database, DRIZZLE_DB } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema.js';
import { alertEnvelopes, alertTypes } from './support/alerts.js';
import { startTestService, type TestService } from './support/test-service.js';

// A pipeline along 110.40°E (2.55°S–2.45°S), away from the other test files.
const ON_LINE = { lat: -2.5, lon: 110.4 };
const PIPELINE = makeTestZone({
  kind: 'pipeline',
  code: 'resolutions-pipeline',
  name: 'Resolutions pipeline',
  bufferM: 1750,
  geometry: {
    type: 'LineString',
    coordinates: [
      [110.4, -2.55],
      [110.4, -2.45],
    ],
  },
});
const WARNING_AT = destinationPoint(ON_LINE, 90, 1000);
const COOLDOWN_MS = 3000;
const RAISED = EVENT_TYPES.ALERT_RAISED;
const RESOLVED = EVENT_TYPES.ALERT_RESOLVED;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `alert.resolved.v1` through the real runner (spec §7.3, §18): published on
 * the raise's subject once `ALERT_COOLDOWN_S` since the last raise passed,
 * never for an occurrence raised again within it.
 */
describe('alert resolutions (alert.resolved.v1 after the alert cooldown)', () => {
  let service: TestService;
  let db: Database<typeof schema>;
  let emitter: AlertEmitter;

  const send = async (mmsi: number, time: Date, anchored: boolean) => {
    const { ack } = await service.app.get(EventPublisher).publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      toPositionPayload({
        mmsi,
        time,
        source: 'primary',
        ...WARNING_AT,
        sog: anchored ? 0.1 : 7,
        cog: anchored ? 0 : 90,
        hdg: 511,
        navstatus: anchored ? 1 : 0,
        predictedNavstatus: anchored ? 1 : 0,
        coastDistanceM: null,
        previous: null,
      }),
    );
    await service.processed('AIS_POSITION', 'safety-positions', ack);
  };
  const types = (mmsi: number) =>
    alertTypes(service.app, subjects.alert('ews', mmsi));
  const rowsOf = (mmsi: number) =>
    db
      .select()
      .from(schema.events)
      .where(eq(schema.events.mmsi, mmsi))
      .orderBy(asc(schema.events.createdAt));

  beforeAll(async () => {
    service = await startTestService({
      env: { ALERT_COOLDOWN_S: String(COOLDOWN_MS / 1000) },
    });
    db = service.app.get<unknown, Database<typeof schema>>(DRIZZLE_DB);
    emitter = service.app.get(AlertEmitter);
    const { ack } = await service.app
      .get(EventPublisher)
      .publishEvent(EVENT_TYPES.GEO_ZONE_UPSERTED, PIPELINE);
    await service.processed('GEO', 'safety-zones', ack);
    await waitFor(() => service.app.get(ZoneIndex).has(PIPELINE.id));
  });

  afterAll(async () => {
    await service.app
      .get(EventPublisher)
      .publishEvent(EVENT_TYPES.GEO_ZONE_DELETED, {
        id: PIPELINE.id,
        orgId: null,
      });
    await service.app.close();
  });

  it('announces a resolution once, after the cooldown since the raise', async () => {
    const mmsi = 525_850_001;
    const t0 = Date.now() - 60_000;
    await send(mmsi, new Date(t0), true);
    await waitFor(async () =>
      (await types(mmsi)).length === 1 ? true : undefined,
    );
    const raisedAt = Date.now();

    await send(mmsi, new Date(t0 + 10_000), false);
    const [row] = await rowsOf(mmsi);
    expect(row).toMatchObject({
      status: 'resolved',
      resolvedAt: new Date(t0 + 10_000),
    });
    // Within the cooldown of its raise: recorded, not announced yet.
    expect(await types(mmsi)).toEqual([RAISED]);

    // The runner's housekeeping (every 30 s) publishes it once the window ended.
    await sleep(Math.max(0, raisedAt + COOLDOWN_MS + 200 - Date.now()));
    await emitter.retryPending();
    const envelopes = await alertEnvelopes(
      service.app,
      subjects.alert('ews', mmsi),
    );
    expect(envelopes.map((envelope) => envelope.type)).toEqual([
      RAISED,
      RESOLVED,
    ]);
    const raise = envelopes[0]?.data as AlertRaisedV1;
    expect(envelopes[1]).toMatchObject({
      type: RESOLVED,
      source: 'safety',
      data: {
        alertId: raise.id,
        dedupKey: raise.dedupKey,
        type: 'ews',
        domain: 'safety',
        severity: 'warning',
        mmsi,
        relatedMmsi: null,
        zoneId: PIPELINE.id,
        openedAt: new Date(t0).toISOString(),
        resolvedAt: new Date(t0 + 10_000).toISOString(),
        reason: 'safe: not at anchor within the warning distance',
        methodId: 'ews.pipeline_distance_status',
        data: {
          ewsStatus: 3,
          messageKey: 'safety.ews.resolved_safe',
          messageParams: {},
        },
      },
    });

    // Later passes publish nothing more.
    await emitter.retryPending();
    expect(await types(mmsi)).toEqual([RAISED, RESOLVED]);
  });

  it('announces nothing when the condition returns within the cooldown', async () => {
    const mmsi = 525_850_002;
    const t0 = Date.now() - 60_000;
    await send(mmsi, new Date(t0), true);
    await waitFor(async () =>
      (await types(mmsi)).length === 1 ? true : undefined,
    );
    const raisedAt = Date.now();
    await send(mmsi, new Date(t0 + 10_000), false);
    await send(mmsi, new Date(t0 + 20_000), true);

    // Reopened as the same occurrence (no new alert, one open row).
    const rows = await rowsOf(mmsi);
    expect(rows.map((row) => row.status)).toEqual(['open']);
    expect(rows[0]?.lastSeenAt).toEqual(new Date(t0 + 20_000));

    await sleep(Math.max(0, raisedAt + COOLDOWN_MS + 200 - Date.now()));
    await emitter.retryPending();
    await emitter.flush();
    expect(await types(mmsi)).toEqual([RAISED]);
  });
});
