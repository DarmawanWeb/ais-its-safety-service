import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import {
  makeTestVesselSnapshot,
  makeTestZone,
} from '@darmawanweb/ais-its-nest/analytics';
import { type Database, DRIZZLE_DB } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher, NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { uniqueName } from '@darmawanweb/ais-its-nest/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema.js';
import { startTestService, type TestService } from './support/test-service.js';

const zone = makeTestZone({
  kind: 'anchorage',
  code: 'it-anchorage',
  name: 'Rebuild anchorage',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [120, -2],
        [120.1, -2],
        [120.1, -1.9],
        [120, -1.9],
        [120, -2],
      ],
    ],
  },
});
const vessel = makeTestVesselSnapshot({
  mmsi: 525_800_001,
  orgId: newId(),
  name: 'KM Rebuild',
  updatedAt: new Date().toISOString(),
});

describe('projections (safety-zones / safety-fleet) and their rebuild on start', () => {
  const durablePrefix = `${uniqueName('p')}-`;
  const services: TestService[] = [];
  const start = async (detectorEnv: Record<string, string> = {}) => {
    const service = await startTestService({ durablePrefix, detectorEnv });
    services.push(service);
    return service;
  };
  const dbOf = (service: TestService) =>
    service.app.get<unknown, Database<typeof schema>>(DRIZZLE_DB);

  afterAll(async () => {
    for (const service of services.splice(0)) await service.app.close();
  });

  it('rebuilds lost rows and removes rows the compacted stream no longer knows', async () => {
    const first = await start();
    const publisher = first.app.get(EventPublisher);
    const zoneAck = await publisher.publishEvent(EVENT_TYPES.GEO_ZONE_UPSERTED, zone);
    await first.processed('GEO', 'safety-zones', zoneAck.ack);
    const vesselAck = await publisher.publishEvent(EVENT_TYPES.FLEET_VESSEL_UPSERTED, vessel);
    await first.processed('FLEET', 'safety-fleet', vesselAck.ack);
    await first.app.close();
    services.length = 0;

    // A database restored from an old backup: the zone row is gone, a zone
    // deleted meanwhile is still there. The durable consumers will not
    // redeliver (same prefix, already acknowledged).
    const db = dbOf(await startOnlyDatabase());
    await db.delete(schema.zones).where(eq(schema.zones.id, zone.id));
    const ghost = newId();
    await db.execute(sql`
      INSERT INTO zones (id, code, name, kind, geom, active, alert_on_enter, source_updated_at, updated_at)
      VALUES (${ghost}, 'ghost', 'Ghost', 'custom', ST_GeogFromText('POINT(120 -2)'), true, false, now(), now() - interval '1 hour')`);

    const second = await start();
    const rows = await dbOf(second)
      .select({ id: schema.zones.id, deletedAt: schema.zones.deletedAt })
      .from(schema.zones)
      .where(sql`${schema.zones.id} IN (${zone.id}, ${ghost})`);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: zone.id, deletedAt: null },
        { id: ghost, deletedAt: expect.any(Date) as unknown },
      ]),
    );
    const vessels = await dbOf(second)
      .select()
      .from(schema.vessels)
      .where(eq(schema.vessels.id, vessel.id));
    expect(vessels).toEqual([expect.objectContaining({ mmsi: vessel.mmsi, deletedAt: null })]);

    // A deletion is a tombstone (an older snapshot can no longer resurrect it).
    const deleted = await second.app
      .get(EventPublisher)
      .publishEvent(EVENT_TYPES.GEO_ZONE_DELETED, { id: zone.id, orgId: null });
    await second.processed('GEO', 'safety-zones', deleted.ack);
    const [tombstone] = await dbOf(second)
      .select()
      .from(schema.zones)
      .where(eq(schema.zones.id, zone.id));
    expect(tombstone?.deletedAt).toBeInstanceOf(Date);
  });

  it('runs a DETECTORS subset on its own durable consumer', async () => {
    const service = await start({ DETECTORS: 'ews' });
    const response = await service.app.inject({
      method: 'GET',
      url: '/api/v2/safety/detectors',
      headers: await service.authorization({ roles: ['viewer'] }),
    });
    expect(response.json()).toEqual([
      expect.objectContaining({ id: 'ews', enabled: true }),
      expect.objectContaining({ id: 'collision', enabled: false, config: null }),
    ]);
    const info = await service.app
      .get(NatsClient)
      .manager.consumers.info('AIS_POSITION', `${durablePrefix}safety-positions-ews`);
    expect(info.name).toBe(`${durablePrefix}safety-positions-ews`);
  });

  /** The application on a fresh prefix, used only for direct table access. */
  async function startOnlyDatabase(): Promise<TestService> {
    return start();
  }
});
