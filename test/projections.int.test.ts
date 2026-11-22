import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import {
  makeTestVesselSnapshot,
  makeTestZone,
} from '@darmawanweb/ais-its-nest/analytics';
import { type Database, DRIZZLE_DB } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher, NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { uniqueName } from '@darmawanweb/ais-its-nest/testing';
import { eq, inArray } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { ZonesRepository } from '../src/consumers/zones.repository.js';
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
  const services: TestService[] = [];
  /** Direct access to the service schema while no application runs. */
  let admin: pg.Pool;

  const start = async (
    options: Parameters<typeof startTestService>[0] = {},
  ): Promise<TestService> => {
    const service = await startTestService(options);
    services.push(service);
    return service;
  };
  const dbOf = (service: TestService) =>
    service.app.get<unknown, Database<typeof schema>>(DRIZZLE_DB);

  beforeAll(() => {
    admin = new pg.Pool({ connectionString: inject('infra').databaseUrl });
  });

  afterAll(async () => {
    for (const service of services.splice(0)) await service.app.close();
    await admin.end();
  });

  it('re-applies lost snapshots and removes rows the compacted streams no longer hold', async () => {
    const durablePrefix = `${uniqueName('p')}-`;
    const first = await start({ durablePrefix });
    const publisher = first.app.get(EventPublisher);
    const zoneAck = await publisher.publishEvent(
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      zone,
    );
    await first.processed('GEO', 'safety-zones', zoneAck.ack);
    const vesselAck = await publisher.publishEvent(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      vessel,
    );
    await first.processed('FLEET', 'safety-fleet', vesselAck.ack);
    await first.app.close();
    services.length = 0;

    // A database restored from an old backup while the service was down: the
    // zone row is gone, and rows the streams no longer hold are still there.
    // The durable consumers will not redeliver (same prefix, all acknowledged).
    const ghostZone = newId();
    const ghostVessel = newId();
    await admin.query('DELETE FROM safety.zones WHERE id = $1', [zone.id]);
    await admin.query(
      `INSERT INTO safety.zones (id, code, name, kind, geom, active, alert_on_enter, source_updated_at, updated_at)
       VALUES ($1, 'ghost', 'Ghost', 'custom', ST_GeogFromText('POINT(120 -2)'), true, false, now(), now() - interval '1 hour')`,
      [ghostZone],
    );
    await admin.query(
      `INSERT INTO safety.vessels (id, mmsi, org_id, name, status, source_updated_at, updated_at)
       VALUES ($1, 525800002, $2, 'KM Ghost', 'active', now(), now() - interval '1 hour')`,
      [ghostVessel, newId()],
    );

    const second = await start({ durablePrefix });
    const db = dbOf(second);
    const zones = await db
      .select({ id: schema.zones.id, deletedAt: schema.zones.deletedAt })
      .from(schema.zones)
      .where(inArray(schema.zones.id, [zone.id, ghostZone]));
    expect(zones).toEqual([{ id: zone.id, deletedAt: null }]);
    const vessels = await db
      .select({ id: schema.vessels.id, mmsi: schema.vessels.mmsi })
      .from(schema.vessels)
      .where(inArray(schema.vessels.id, [vessel.id, ghostVessel]));
    expect(vessels).toEqual([{ id: vessel.id, mmsi: vessel.mmsi }]);

    // A deletion is a tombstone: an older snapshot can no longer resurrect it.
    const deleted = await second.app
      .get(EventPublisher)
      .publishEvent(EVENT_TYPES.GEO_ZONE_DELETED, { id: zone.id, orgId: null });
    await second.processed('GEO', 'safety-zones', deleted.ack);
    expect(await second.app.get(ZonesRepository).upsert(zone)).toBe(false);
    const [tombstone] = await db
      .select()
      .from(schema.zones)
      .where(eq(schema.zones.id, zone.id));
    expect(tombstone?.deletedAt).toBeInstanceOf(Date);
  });

  it('runs a DETECTORS subset on its own durable consumer', async () => {
    const durablePrefix = `${uniqueName('d')}-`;
    const service = await start({
      durablePrefix,
      detectorEnv: { DETECTORS: 'ews' },
    });
    const response = await service.app.inject({
      method: 'GET',
      url: '/api/v2/safety/detectors',
      headers: await service.authorization({ roles: ['viewer'] }),
    });
    expect(response.json()).toEqual([
      expect.objectContaining({ id: 'ews', enabled: true }),
      expect.objectContaining({
        id: 'collision',
        enabled: false,
        config: null,
      }),
    ]);
    const info = await service.app
      .get(NatsClient)
      .manager.consumers.info(
        'AIS_POSITION',
        `${durablePrefix}safety-positions-ews`,
      );
    expect(info.name).toBe(`${durablePrefix}safety-positions-ews`);
  });
});
