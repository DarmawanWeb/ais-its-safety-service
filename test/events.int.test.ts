import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  type AlertRaisedV1,
  EVENT_TYPES,
} from '@darmawanweb/ais-its-contracts/events';
import {
  destinationPoint,
  makeTestZone,
  type OpenAlert,
  toPositionPayload,
  ZoneIndex,
} from '@darmawanweb/ais-its-nest/analytics';
import { type Database, DRIZZLE_DB } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema.js';
import { DetectorEventsRepository } from '../src/detectors/detector-events.repository.js';
import { EncountersRepository } from '../src/modules/encounters/encounters.repository.js';
import { startTestService, type TestService } from './support/test-service.js';

const MINUTE = 60_000;
const authority = { roles: ['authority'] as const, orgId: null };

function alert(
  overrides: Partial<AlertRaisedV1> & Pick<AlertRaisedV1, 'dedupKey' | 'mmsi'>,
): AlertRaisedV1 {
  return {
    id: newId(),
    type: 'ews',
    domain: 'safety',
    severity: 'warning',
    relatedMmsi: null,
    title: 'Pipeline warning',
    message: 'test',
    lat: -1.5,
    lon: 106,
    occurredAt: new Date().toISOString(),
    zoneId: null,
    methodId: 'ews.pipeline_distance_status',
    data: {},
    ...overrides,
  };
}

describe('events and encounters (review findings: invariant, event time, windows, pagination)', () => {
  let service: TestService;
  let db: Database<typeof schema>;
  let repository: DetectorEventsRepository;
  const get = async (url: string) =>
    service.app.inject({
      method: 'GET',
      url,
      headers: await service.authorization(authority),
    });
  const rowsOf = (mmsi: number) =>
    db
      .select()
      .from(schema.events)
      .where(eq(schema.events.mmsi, mmsi))
      .orderBy(asc(schema.events.createdAt));

  beforeAll(async () => {
    service = await startTestService();
    db = service.app.get<unknown, Database<typeof schema>>(DRIZZLE_DB);
    repository = service.app.get(DetectorEventsRepository);
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('keeps one open row per dedup key, whatever opens it', async () => {
    const mmsi = 525_830_001;
    const dedupKey = `ews:${mmsi}:${newId()}`;
    const t0 = new Date(Date.now() - 30 * MINUTE);
    const at = (minutes: number) => new Date(t0.getTime() + minutes * MINUTE);
    const first = alert({ dedupKey, mmsi, occurredAt: t0.toISOString() });
    const stale = alert({
      dedupKey,
      mmsi,
      occurredAt: at(1).toISOString(),
    });
    await repository.onRaised(first, 'raised');
    // An instance with a stale alert state raises the same condition again.
    await repository.onRaised(stale, 'raised');
    let rows = await rowsOf(mmsi);
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      [first.id, 'resolved'],
      [stale.id, 'open'],
    ]);
    expect(rows[0]?.resolution).toEqual({
      reason: 'superseded',
      supersededBy: stale.id,
      messageKey: 'safety.ews.superseded',
      messageParams: {},
    });
    expect(rows[1]?.openedAt).toEqual(t0);

    // Reopening the first one (a suppressed re-raise) supersedes the other;
    // last_seen_at takes the signal's event time, not the emitter clock.
    const reopened: OpenAlert = {
      alertId: first.id,
      dedupKey,
      type: 'ews',
      mmsi,
      relatedMmsi: null,
      zoneId: null,
      severity: 'warning',
      publishedSeverity: 'warning',
      openedAt: t0,
      publishedAt: t0,
      lastSeenAt: t0,
      detector: 'ews',
    };
    await repository.onUpdated({
      reason: 'suppressed',
      reopened: true,
      previousSeverity: 'warning',
      at: new Date(),
      occurredAt: at(3),
      alert: reopened,
    });
    rows = await rowsOf(mmsi);
    expect(rows.map((row) => row.status)).toEqual(['open', 'resolved']);
    expect(rows[0]?.lastSeenAt).toEqual(at(3));
    expect(rows[1]?.resolution).toMatchObject({
      reason: 'superseded',
      supersededBy: first.id,
    });
    expect(rows[1]?.resolvedAt).toEqual(at(3));

    // Repeats (onRepeated) and de-escalations never move last_seen_at back.
    await repository.onRepeated(reopened, at(5));
    await repository.onRepeated(reopened, at(2));
    await repository.onUpdated({
      reason: 'de-escalated',
      reopened: false,
      previousSeverity: 'critical',
      at: new Date(),
      occurredAt: at(4),
      alert: reopened,
    });
    expect((await rowsOf(mmsi))[0]?.lastSeenAt).toEqual(at(5));

    // loadOpen returns the occurrence with its event times, domain and method.
    const open = (await repository.loadOpen()).filter(
      (row) => row.dedupKey === dedupKey,
    );
    expect(open).toEqual([
      expect.objectContaining({
        alertId: first.id,
        detector: 'ews',
        domain: 'safety',
        methodId: 'ews.pipeline_distance_status',
        firstOccurredAt: t0,
        lastOccurredAt: at(5),
      }),
    ]);

    // The resolution closes the open row once (a repeat is a no-op).
    const resolution = {
      alert: reopened,
      resolvedAt: at(6),
      reason: 'safe: not at anchor within the warning distance',
      data: { messageKey: 'safety.ews.resolved_safe', messageParams: {} },
    };
    await repository.onResolved(resolution);
    await repository.onResolved({ ...resolution, resolvedAt: at(7) });
    rows = await rowsOf(mmsi);
    expect(rows.map((row) => row.status)).toEqual(['resolved', 'resolved']);
    expect(rows[0]).toMatchObject({
      resolvedAt: at(6),
      lastSeenAt: at(5),
      resolution: {
        reason: 'safe: not at anchor within the warning distance',
        messageKey: 'safety.ews.resolved_safe',
        messageParams: {},
      },
    });
  });

  it('keeps last_seen_at in event time while the condition lasts', async () => {
    const mmsi = 525_830_002;
    const onLine = { lat: -1.5, lon: 106.0 };
    const zone = makeTestZone({
      kind: 'pipeline',
      code: 'events-pipeline',
      name: 'Events pipeline',
      bufferM: 1750,
      geometry: {
        type: 'LineString',
        coordinates: [
          [106.0, -1.55],
          [106.0, -1.45],
        ],
      },
    });
    const publisher = service.app.get(EventPublisher);
    const zoneAck = await publisher.publishEvent(
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      zone,
    );
    await service.processed('GEO', 'safety-zones', zoneAck.ack);
    await waitFor(() => service.app.get(ZoneIndex).has(zone.id));
    const send = async (time: Date, anchored: boolean) => {
      const { ack } = await publisher.publishEvent(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        toPositionPayload({
          mmsi,
          time,
          source: 'primary',
          ...destinationPoint(onLine, 90, 1000),
          sog: anchored ? 0.1 : 7,
          cog: 0,
          hdg: 511,
          navstatus: anchored ? 1 : 0,
          predictedNavstatus: anchored ? 1 : 0,
          coastDistanceM: null,
          previous: null,
        }),
      );
      await service.processed('AIS_POSITION', 'safety-positions', ack);
    };

    // The AIS event time lags the wall clock by 10 minutes.
    const t0 = new Date(Date.now() - 10 * MINUTE);
    await send(t0, true);
    await send(new Date(t0.getTime() + 2 * MINUTE), true);
    const [open] = await waitFor(async () => {
      const rows = await rowsOf(mmsi);
      return rows[0]?.lastSeenAt.getTime() === t0.getTime() + 2 * MINUTE
        ? rows
        : undefined;
    });
    expect(open).toMatchObject({ status: 'open', time: t0, openedAt: t0 });

    await send(new Date(t0.getTime() + 3 * MINUTE), false);
    const [resolved] = await waitFor(async () => {
      const rows = await rowsOf(mmsi);
      return rows[0]?.status === 'resolved' ? rows : undefined;
    });
    expect(resolved?.resolvedAt).toEqual(new Date(t0.getTime() + 3 * MINUTE));
    expect(resolved?.lastSeenAt).toEqual(new Date(t0.getTime() + 2 * MINUTE));

    const body = (await get(`/api/v2/safety/events?mmsi=${mmsi}`)).json<{
      data: { lastSeenAt: string }[];
    }>();
    expect(body.data[0]?.lastSeenAt).toBe(
      new Date(t0.getTime() + 2 * MINUTE).toISOString(),
    );
    await publisher.publishEvent(EVENT_TYPES.GEO_ZONE_DELETED, {
      id: zone.id,
      orgId: null,
    });
  });

  it('lists open occurrences raised more than 7 days ago with status=open', async () => {
    const mmsi = 525_830_003;
    const old = alert({
      dedupKey: `ews:${mmsi}:${newId()}`,
      mmsi,
      occurredAt: new Date(Date.now() - 8 * 24 * 60 * MINUTE).toISOString(),
    });
    await repository.onRaised(old, 'raised');
    interface Page {
      data: { id: string }[];
    }
    expect(
      (await get(`/api/v2/safety/events?status=open&mmsi=${mmsi}`))
        .json<Page>()
        .data.map((event) => event.id),
    ).toEqual([old.id]);
    // Without status=open the default 7-day range applies.
    expect(
      (await get(`/api/v2/safety/events?mmsi=${mmsi}`)).json<Page>().data,
    ).toEqual([]);
    // An explicit `from` still bounds the open occurrences.
    expect(
      (
        await get(
          `/api/v2/safety/events?status=open&mmsi=${mmsi}&from=${new Date(Date.now() - 60 * MINUTE).toISOString()}`,
        )
      ).json<Page>().data,
    ).toEqual([]);
  });

  it('pages through the encounters without skipping one that gets new samples', async () => {
    const encounters = service.app.get(EncountersRepository);
    const ids = [newId(), newId(), newId()].sort();
    const now = Date.now();
    const positions = (a: number, b: number) => ({
      a: {
        mmsi: a,
        time: new Date(now).toISOString(),
        lat: -1,
        lon: 106,
        sog: 10,
        cog: 0,
      },
      b: {
        mmsi: b,
        time: new Date(now).toISOString(),
        lat: -1,
        lon: 106.01,
        sog: 10,
        cog: 180,
      },
    });
    const sample = (index: number, minutesAgo: number) => {
      const mmsiA = 525_840_001 + index * 2;
      return {
        time: new Date(now - minutesAgo * MINUTE),
        mmsiA,
        mmsiB: mmsiA + 1,
        encounterId: ids[index] ?? '',
        cpaNm: 0.3,
        tcpaMin: 8,
        rangeNm: 2,
        risk: 'medium' as const,
        positions: positions(mmsiA, mmsiA + 1),
      };
    };
    // Latest samples: newest encounter (ids[2]) 5 min ago, oldest (ids[0]) 30 min ago.
    await encounters.insert([sample(2, 5), sample(1, 20), sample(0, 30)]);

    const from = new Date(now - 60 * MINUTE).toISOString();
    interface Page {
      data: { encounterId: string }[];
      page: { nextCursor: string | null };
    }
    const pageAt = async (cursor: string | null): Promise<Page> =>
      (
        await get(
          `/api/v2/safety/encounters?limit=1&from=${from}${cursor === null ? '' : `&cursor=${cursor}`}`,
        )
      ).json<Page>();
    const first = await pageAt(null);
    // The oldest encounter, not returned yet, gets a new sample: ordered by
    // its latest sample it would jump before the cursor and be skipped.
    await encounters.insert([sample(0, 0)]);
    const seen = first.data.map((item) => item.encounterId);
    let cursor = first.page.nextCursor;
    for (let pages = 1; cursor !== null && pages < 50; pages += 1) {
      const page = await pageAt(cursor);
      seen.push(...page.data.map((item) => item.encounterId));
      cursor = page.page.nextCursor;
    }

    for (const id of ids)
      expect(seen.filter((item) => item === id)).toHaveLength(1);
    const mine = seen.filter((item) => ids.includes(item));
    expect(mine).toEqual([...ids].reverse());
  });

  it('filters active encounters: latest sample at risk and recent (event time)', async () => {
    const encounters = service.app.get(EncountersRepository);
    const now = Date.now();
    const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000);
    const pair = (index: number) => 525_860_001 + index * 2;
    const report = (mmsi: number, time: Date, lon: number) => ({
      mmsi,
      time: time.toISOString(),
      lat: -1.2,
      lon,
      sog: 10,
      cog: 90,
    });
    const encounter = (
      index: number,
      samples: readonly [secondsAgo: number, risk: 'medium' | 'none'][],
    ) => {
      const mmsiA = pair(index);
      const encounterId = newId();
      return samples.map(([secondsAgo, risk]) => ({
        time: at(secondsAgo),
        mmsiA,
        mmsiB: mmsiA + 1,
        encounterId,
        cpaNm: 0.3,
        tcpaMin: risk === 'none' ? -1 : 8,
        rangeNm: 1.5,
        risk,
        positions: {
          a: report(mmsiA, at(secondsAgo), 106.3),
          b: report(mmsiA + 1, at(secondsAgo), 106.32),
        },
      }));
    };
    const ongoing = encounter(0, [
      [400, 'medium'],
      [20, 'medium'],
    ]);
    const stale = encounter(1, [[600, 'medium']]);
    const ended = encounter(2, [
      [90, 'medium'],
      [20, 'none'],
    ]);
    await encounters.insert([...ongoing, ...stale, ...ended]);
    const ids = (samples: readonly { encounterId: string }[]) =>
      samples[0]?.encounterId;
    const listed = async (query: string) =>
      (
        await get(
          `/api/v2/safety/encounters?bbox=106.2,-1.3,106.4,-1.1&from=${at(3600).toISOString()}&${query}`,
        )
      ).json<{
        data: { encounterId: string }[];
        page: { nextCursor: string | null };
      }>();

    expect(
      (await listed('active=true')).data.map((e) => e.encounterId),
    ).toEqual([ids(ongoing)]);
    expect(
      (await listed('active=false')).data.map((e) => e.encounterId).sort(),
    ).toEqual([ids(stale), ids(ended)].sort());
    expect((await listed('')).data).toHaveLength(3);

    // Pages of a filtered list keep the first page's cut-off in the cursor.
    const first = await listed('active=false&limit=1');
    expect(first.data).toHaveLength(1);
    const second = await listed(
      `active=false&limit=1&cursor=${first.page.nextCursor ?? ''}`,
    );
    expect(
      [...first.data, ...second.data].map((e) => e.encounterId).sort(),
    ).toEqual([ids(stale), ids(ended)].sort());
  });
});
