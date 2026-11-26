import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import {
  toPositionPayload,
  type VesselPosition,
  VesselStateStore,
} from '@darmawanweb/ais-its-nest/analytics';
import { type Database, DRIZZLE_DB } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher, NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { uniqueName, waitFor } from '@darmawanweb/ais-its-nest/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema.js';
import { startTestService, type TestService } from './support/test-service.js';

// The area of this file: crossings around 4.5°S 109.5°E, away from the other test files.
const LAT0 = -4.5;
const LON0 = 109.5;
/** A point `x` nm east and `y` nm north of the origin. */
const place = (x: number, y: number) => ({
  lat: LAT0 + y / 60,
  lon: LON0 + x / (60 * Math.cos((LAT0 * Math.PI) / 180)),
});

const LAG_A = 525_880_001;
const LAG_B = 525_880_002;
const CLOCK = 525_880_009; // far from both pairs: only moves the event clock
const TAKEOVER_A = 525_880_011;
const TAKEOVER_B = 525_880_012;

function position(
  mmsi: number,
  at: { lat: number; lon: number },
  cog: number,
  time: number,
): VesselPosition {
  return {
    mmsi,
    time: new Date(time),
    source: 'primary',
    ...at,
    sog: 12,
    cog,
    hdg: 511,
    navstatus: 0,
    predictedNavstatus: 0,
    coastDistanceM: null,
    previous: null,
  };
}

/**
 * Both vessels of a crossing `minute` after its `start`: A sails north from
 * (x, 0), B west from (x + 2, 2), both at 12 kn, so they would meet at
 * (x, 2) at minute 10 (CPA 0, TCPA 10 − minute: `medium` for 4 minutes).
 */
function crossing(
  [a, b]: readonly [number, number],
  x: number,
  start: number,
  minute: number,
): VesselPosition[] {
  const time = start + minute * 60_000;
  return [
    position(a, place(x, minute / 5), 0, time),
    position(b, place(x + 2 - minute / 5, 2), 270, time + 1000),
  ];
}

/**
 * `active=true` must follow what the collision detector tracks: one active
 * encounter per pair (a takeover starts the pair over with a new encounter
 * and leaves the previous one without a closing `none` sample), measured on
 * the detector's event clock (AIS time lags the wall clock).
 */
describe('active encounters: per pair, in event time (GET /safety/encounters?active)', () => {
  const durablePrefix = `${uniqueName('enc')}-`;
  const env = { DETECTOR_PINNED_TTL_MS: '3000' };
  const authority = { roles: ['authority'] as const, orgId: newId() };
  let a: TestService;
  let b: TestService | undefined;
  let aClosed = false;

  /** Encounter ids of `mmsi` (newest first) for the extra `query`. */
  const encounterIds = async (
    service: TestService,
    mmsi: number,
    query = '',
  ): Promise<string[]> => {
    const response = await service.app.inject({
      method: 'GET',
      url: `/api/v2/safety/encounters?mmsi=${mmsi}${query}`,
      headers: await service.authorization(authority),
    });
    expect(response.statusCode).toBe(200);
    return response
      .json<{ data: { encounterId: string }[] }>()
      .data.map((item) => item.encounterId);
  };
  const publish = async (
    service: TestService,
    positions: readonly VesselPosition[],
  ): Promise<void> => {
    for (const input of positions) {
      const { ack } = await service.app
        .get(EventPublisher)
        .publishEvent(
          EVENT_TYPES.AIS_POSITION_RECORDED,
          toPositionPayload(input),
        );
      await service.processed('AIS_POSITION', 'safety-positions', ack);
    }
  };
  /** Waits until the collision state of `mmsi` evaluated at `time` is stored (the clock). */
  const stored = (db: Database<typeof schema>, mmsi: number, time: number) =>
    waitFor(
      async () => {
        const [row] = await db
          .select({ at: schema.vesselState.collisionEvaluatedAt })
          .from(schema.vesselState)
          .where(eq(schema.vesselState.mmsi, mmsi));
        return row?.at?.getTime() === time ? true : undefined;
      },
      { message: `collision state of ${mmsi}` },
    );

  beforeAll(async () => {
    // Both clocks are global (the detector's newest position time, the newest
    // collision evaluation of any vessel) and a new durable replays the whole
    // AIS_POSITION stream: the positions of the files that ran before, near the
    // wall clock, would move them ahead of this file's lagging AIS time (and
    // the detector would close this file's pairs as stale). Start from an
    // empty stream, whatever the file order.
    const purger = await startTestService();
    await purger.app.get(NatsClient).manager.streams.purge('AIS_POSITION');
    await purger.app.close();
    a = await startTestService({ durablePrefix, env });
  });

  afterAll(async () => {
    const open = [...(aClosed ? [] : [a]), ...(b === undefined ? [] : [b])];
    for (const service of open) await service.app.close();
  });

  it('measures the window on the collision detector’s event clock, not the request time', async () => {
    const db = a.app.get<unknown, Database<typeof schema>>(DRIZZLE_DB);
    // The clock is global (the newest collision evaluation of any vessel):
    // start without the states of the other files, so this test sets it.
    await db.delete(schema.vesselState).where(sql`true`);
    // AIS time 10 minutes behind the wall clock (a backlog after an outage).
    const t0 = Date.now() - 10 * 60_000;
    await publish(a, [
      ...crossing([LAG_A, LAG_B], 0, t0, 0),
      ...crossing([LAG_A, LAG_B], 0, t0, 1 / 3),
    ]);
    await stored(db, LAG_B, t0 + 21_000);
    const [encounter] = await encounterIds(a, LAG_A);
    expect(encounter).toBeDefined();

    // The latest sample (t0 + 1 s) is 20 s old on the clock, 10 min by the wall clock.
    expect(await encounterIds(a, LAG_A, '&active=true')).toEqual([encounter]);
    expect(await encounterIds(a, LAG_A, '&active=false')).toEqual([]);

    // The clock passes the window (180 s) without a new sample of the pair: ended.
    await publish(a, [position(CLOCK, place(60, 60), 90, t0 + 200_000)]);
    await stored(db, CLOCK, t0 + 200_000);
    expect(await encounterIds(a, LAG_A, '&active=true')).toEqual([]);
    expect(await encounterIds(a, LAG_A, '&active=false')).toEqual([encounter]);
  });

  it('keeps one active encounter per pair across a takeover', async () => {
    const t1 = Date.now() - 60_000;
    const pair = [TAKEOVER_A, TAKEOVER_B] as const;
    // A, the active instance, follows the pair at medium risk: encounter 1.
    await publish(a, [
      ...crossing(pair, 20, t1, 0),
      ...crossing(pair, 20, t1, 1 / 3),
    ]);
    const [first] = await encounterIds(a, TAKEOVER_A);
    expect(first).toBeDefined();

    // B boots as the standby; A stops gracefully and releases the pin.
    const standby = await startTestService({ durablePrefix, env });
    b = standby;
    await a.app.close();
    aClosed = true;

    // B takes over and keeps evaluating the pair. Its tracker starts over:
    // encounter 2, while encounter 1 never gets a closing `none` sample.
    const [nextA, nextB] = crossing(pair, 20, t1, 2 / 3);
    if (nextA === undefined || nextB === undefined) throw new Error('crossing');
    const { ack } = await standby.app
      .get(EventPublisher)
      .publishEvent(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        toPositionPayload(nextA),
      );
    await waitFor(
      () => standby.app.get(VesselStateStore).get(TAKEOVER_A) !== undefined,
      { timeoutMs: 30_000, message: 'B took over' },
    );
    await standby.processed('AIS_POSITION', 'safety-positions', ack);
    await publish(standby, [nextB]);

    const all = await encounterIds(standby, TAKEOVER_A);
    expect(all).toHaveLength(2);
    const [second, previous] = all;
    expect(previous).toBe(first);
    expect(second).not.toBe(first);
    // Both have samples within the window; only the newest of the pair is active.
    expect(await encounterIds(standby, TAKEOVER_A, '&active=true')).toEqual([
      second,
    ]);
    expect(await encounterIds(standby, TAKEOVER_A, '&active=false')).toEqual([
      first,
    ]);
  });
});
