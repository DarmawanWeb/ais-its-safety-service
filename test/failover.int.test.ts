import {
  type AlertRaisedV1,
  type AlertResolvedV1,
  EVENT_TYPES,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import {
  AlertEmitter,
  destinationPoint,
  makeTestZone,
  toPositionPayload,
  type VesselPosition,
  VesselStateStore,
  ZoneIndex,
} from '@darmawanweb/ais-its-nest/analytics';
import { type Database, DRIZZLE_DB } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher } from '@darmawanweb/ais-its-nest/nats';
import { uniqueName, waitFor } from '@darmawanweb/ais-its-nest/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema.js';
import { alertEnvelopes, alertTypes } from './support/alerts.js';
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

const RAISED = EVENT_TYPES.ALERT_RAISED;
const RESOLVED = EVENT_TYPES.ALERT_RESOLVED;
const keyOf = (mmsi: number) => `ews:${mmsi}:${PIPELINE.id}`;

/**
 * A standby that takes over must neither raise again what the previous
 * instance raised after the standby booted, nor ignore what that instance
 * resolved meanwhile: the kit reloads the open occurrences from `events`
 * when the instance becomes active, before its first position, and a
 * graceful stop releases the pin at once.
 */
describe('failover between two instances of one durable (exclusive consumer)', () => {
  const durablePrefix = `${uniqueName('ha')}-`;
  const env = { DETECTOR_PINNED_TTL_MS: '3000', ALERT_COOLDOWN_S: '0' };
  let a: TestService;
  let b: TestService | undefined;
  let aClosed = false;
  let db: Database<typeof schema>;

  /** Event types on the vessel's alert subject (raises and resolutions). */
  const published = (service: TestService, mmsi: number) =>
    alertTypes(service.app, subjects.alert('ews', mmsi));
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
      (await published(a, RESOLVED_ELSEWHERE)).length === 1 ? true : undefined,
    );

    // B boots as the standby and restores that open alert.
    const standby = await startTestService({ durablePrefix, env });
    b = standby;
    // A closes its pool when it stops: read the table through B.
    db = standby.app.get<unknown, Database<typeof schema>>(DRIZZLE_DB);
    await waitFor(() => standby.app.get(ZoneIndex).has(PIPELINE.id));
    const emitterB = standby.app.get(AlertEmitter);
    expect(emitterB.isOpen(keyOf(RESOLVED_ELSEWHERE))).toBe(true);

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
    // ALERT_COOLDOWN_S=0: A announces its resolution at once.
    await waitFor(async () =>
      (await published(a, RESOLVED_ELSEWHERE)).length === 2 ? true : undefined,
    );
    await waitFor(async () =>
      (await published(a, RAISED_ELSEWHERE)).length === 1 ? true : undefined,
    );
    expect(emitterB.isOpen(keyOf(RESOLVED_ELSEWHERE))).toBe(true);
    expect(emitterB.isOpen(keyOf(RAISED_ELSEWHERE))).toBe(false);

    // A stops gracefully and releases the pin: B takes over with its next pull.
    await a.app.close();
    aClosed = true;
    const probe = await publish(
      standby,
      position(PROBE, new Date(t0 + 20_000), false),
    );
    await waitFor(
      () => standby.app.get(VesselStateStore).get(PROBE) !== undefined,
      { timeoutMs: 30_000, message: 'B took over' },
    );
    await standby.processed('AIS_POSITION', 'safety-positions', probe);

    // B activated before its first position with A's open occurrences.
    expect(emitterB.isOpen(keyOf(RESOLVED_ELSEWHERE))).toBe(false);
    expect(emitterB.get(keyOf(RAISED_ELSEWHERE))).toMatchObject({
      severity: 'warning',
      lastOccurredAt: new Date(t0 + 10_000),
    });

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

    // Resolved elsewhere → raised again (a new occurrence).
    expect(await published(standby, RESOLVED_ELSEWHERE)).toEqual([
      RAISED,
      RESOLVED,
      RAISED,
    ]);
    expect((await rows(RESOLVED_ELSEWHERE)).map((row) => row.status)).toEqual([
      'resolved',
      'open',
    ]);
    // Raised elsewhere → not raised again, one open row.
    expect(await published(standby, RAISED_ELSEWHERE)).toEqual([RAISED]);
    expect((await rows(RAISED_ELSEWHERE)).map((row) => row.status)).toEqual([
      'open',
    ]);

    // Under way again: B resolves the occurrence A raised and announces it once.
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
    const envelopes = await waitFor(async () => {
      const stored = await alertEnvelopes(
        standby.app,
        subjects.alert('ews', RAISED_ELSEWHERE),
      );
      return stored.length === 2 ? stored : undefined;
    });
    const [raise, resolution] = envelopes;
    expect(resolution?.type).toBe(RESOLVED);
    expect(resolution?.data).toMatchObject({
      alertId: (raise?.data as AlertRaisedV1).id,
      dedupKey: keyOf(RAISED_ELSEWHERE),
      type: 'ews',
      domain: 'safety',
      severity: 'warning',
      mmsi: RAISED_ELSEWHERE,
      zoneId: PIPELINE.id,
      openedAt: new Date(t0 + 10_000).toISOString(),
      resolvedAt: new Date(t0 + 40_000).toISOString(),
      reason: 'safe: not at anchor within the warning distance',
      methodId: 'ews.pipeline_distance_status',
      data: expect.objectContaining({
        messageKey: 'safety.ews.resolved_safe',
      }) as unknown,
    } satisfies Partial<Record<keyof AlertResolvedV1, unknown>>);
    expect(resolution?.id).toBe((resolution?.data as AlertResolvedV1).id);
  });
});
