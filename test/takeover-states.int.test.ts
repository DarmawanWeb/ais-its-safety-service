import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  EVENT_TYPES,
  parseEnvelope,
  type SafetyVesselStateV1,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import {
  DetectorEngine,
  toPositionPayload,
  type VesselPosition,
  VesselStateStore,
} from '@darmawanweb/ais-its-nest/analytics';
import { type Database, DRIZZLE_DB } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher, NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { uniqueName, waitFor } from '@darmawanweb/ais-its-nest/testing';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema.js';
import { SafetyStateWriter } from '../src/modules/vessel-states/safety-state.writer.js';
import { VesselStatesRepository } from '../src/modules/vessel-states/vessel-states.repository.js';
import { startTestService, type TestService } from './support/test-service.js';

// The area of this file: a crossing around 6°S 103°E, away from the other test files.
const LAT0 = -6;
const LON0 = 103;
const BBOX = '102.8,-6.2,103.4,-5.6';
/** A point `x` nm east and `y` nm north of the origin. */
const place = (x: number, y: number) => ({
  lat: LAT0 + y / 60,
  lon: LON0 + x / (60 * Math.cos((LAT0 * Math.PI) / 180)),
});

const PAIR_A = 525_870_001;
const PAIR_B = 525_870_002;
const CLOCK = 525_870_009; // 60 nm away: only moves the event clock
const GUARDED = 525_870_021; // the reset's guard, on the repository

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
 * (0, 0), B west from (2, 2), both at 12 kn, so they would meet at (0, 2) at
 * minute 10 (CPA 0, TCPA 10 − minute: `high` from minute 5).
 */
function crossing(start: number, minute: number): VesselPosition[] {
  const time = start + minute * 60_000;
  return [
    position(PAIR_A, place(0, minute / 5), 0, time),
    position(PAIR_B, place(2 - minute / 5, 2), 270, time + 1000),
  ];
}

/**
 * A pair at risk when the active instance hands over, whose vessels never
 * report again: the new active instance restores the open alert, never
 * follows the pair and resolves the alert once its window passed — and the
 * stored bands of both vessels must fall back with it (they count in
 * `GET /safety/stats` and in the list for 24 h otherwise).
 */
describe('a pair at risk across a takeover that is never evaluated again', () => {
  const durablePrefix = `${uniqueName('tko')}-`;
  const env = { DETECTOR_PINNED_TTL_MS: '3000' };
  const authority = { roles: ['authority'] as const, orgId: newId() };
  let a: TestService;
  let b: TestService | undefined;
  let aClosed = false;

  const get = async (service: TestService, url: string) => {
    const response = await service.app.inject({
      method: 'GET',
      url,
      headers: await service.authorization(authority),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<unknown>();
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
  /** Stored collision part of the pair's vessels. */
  const bands = async (service: TestService) => {
    const db = service.app.get<unknown, Database<typeof schema>>(DRIZZLE_DB);
    const rows = await db
      .select({
        mmsi: schema.vesselState.mmsi,
        risk: schema.vesselState.collisionRisk,
        closest: schema.vesselState.closestEncounter,
      })
      .from(schema.vesselState)
      .where(inArray(schema.vesselState.mmsi, [PAIR_A, PAIR_B]))
      .orderBy(schema.vesselState.mmsi);
    return rows.map((row) => [row.mmsi, row.risk, row.closest?.otherMmsi]);
  };
  const collisionStats = async (service: TestService) =>
    (
      (await get(service, `/api/v2/safety/stats?bbox=${BBOX}`)) as {
        collision: { high: number; medium: number };
      }
    ).collision;
  const statuses = async (service: TestService) =>
    (
      (await get(
        service,
        `/api/v2/safety/events?mmsi=${PAIR_A}&detector=collision`,
      )) as { data: { status: string }[] }
    ).data.map((event) => event.status);
  /** The last state of `mmsi` on `SAFETY`. */
  const published = async (
    service: TestService,
    mmsi: number,
  ): Promise<SafetyVesselStateV1 | undefined> => {
    const message = await service.app
      .get(NatsClient)
      .manager.streams.getMessage('SAFETY', {
        last_by_subj: subjects.safetyState(mmsi),
      });
    const parsed = parseEnvelope(message?.data);
    return parsed.success &&
      parsed.envelope.type === EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED
      ? parsed.envelope.data
      : undefined;
  };

  beforeAll(async () => {
    // A new durable replays AIS_POSITION: the positions of the files that ran
    // before would move the event clock (see test/encounters.int.test.ts).
    const purger = await startTestService();
    await purger.app.get(NatsClient).manager.streams.purge('AIS_POSITION');
    await purger.app.close();
    a = await startTestService({ durablePrefix, env });
  });

  afterAll(async () => {
    const open = [...(aClosed ? [] : [a]), ...(b === undefined ? [] : [b])];
    for (const service of open) await service.app.close();
  });

  it('falls back both stored bands when the new active instance resolves the alert', async () => {
    // AIS time 10 min behind the wall clock; A follows the crossing at high risk.
    const t = Date.now() - 10 * 60_000;
    await publish(a, [...crossing(t, 5), ...crossing(t, 5 + 1 / 3)]);
    await waitFor(
      async () => ((await bands(a))[1]?.[1] === 'high' ? true : undefined),
      { message: 'the pair at risk' },
    );
    expect(await bands(a)).toEqual([
      [PAIR_A, 'high', PAIR_B],
      [PAIR_B, 'high', PAIR_A],
    ]);
    expect(await collisionStats(a)).toEqual({
      high: 2,
      medium: 0,
      methodId: 'collision.cpa_tcpa',
    });
    expect(await statuses(a)).toEqual(['open']);

    // B boots as the standby; A stops gracefully and releases the pin.
    const standby = await startTestService({ durablePrefix, env });
    b = standby;
    await a.app.close();
    aClosed = true;

    // B takes over on another vessel's position; the pair never reports again.
    const first = position(CLOCK, place(60, 60), 90, t + 300_000);
    const { ack } = await standby.app
      .get(EventPublisher)
      .publishEvent(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        toPositionPayload(first),
      );
    await waitFor(
      () => standby.app.get(VesselStateStore).get(CLOCK) !== undefined,
      { timeoutMs: 30_000, message: 'B took over' },
    );
    await standby.processed('AIS_POSITION', 'safety-positions', ack);
    // B restored the open alert: the band stays while the pair may still report.
    const tick = () =>
      standby.app.get(DetectorEngine).tick(new Date(), ['collision']);
    await tick();
    await standby.app.get(SafetyStateWriter).flush();
    expect(await statuses(standby)).toEqual(['open']);
    expect(await collisionStats(standby)).toMatchObject({ high: 2 });

    // The clock passes the window of the active period (120 s): B resolves
    // the alert of the pair it never evaluated, and both bands fall back.
    await publish(standby, [position(CLOCK, place(60.5, 60), 90, t + 500_000)]);
    await tick();
    await standby.app.get(SafetyStateWriter).flush();
    expect(await statuses(standby)).toEqual(['resolved']);
    expect(await bands(standby)).toEqual([
      [PAIR_A, 'none', undefined],
      [PAIR_B, 'none', undefined],
    ]);
    expect(await collisionStats(standby)).toEqual({
      high: 0,
      medium: 0,
      methodId: 'collision.cpa_tcpa',
    });
    expect(
      await get(
        standby,
        `/api/v2/safety/vessels?bbox=${BBOX}&collisionRisk=medium,high`,
      ),
    ).toEqual([]);
    expect(
      await get(standby, `/api/v2/safety/vessels/${PAIR_B}`),
    ).toMatchObject({ collisionRisk: 'none', closestEncounter: null });
    // SAFETY carries the fall-back like any other change.
    for (const mmsi of [PAIR_A, PAIR_B])
      expect(await published(standby, mmsi)).toMatchObject({
        collisionRisk: 'none',
        closestEncounter: null,
      });
  });

  it('resets only a stored collision part that is not newer and not already none', async () => {
    const service = b ?? a;
    const repository = service.app.get(VesselStatesRepository);
    const at = new Date(Date.now() - 60_000);
    const later = (seconds: number) => new Date(at.getTime() + seconds * 1000);
    await repository.upsertReports([
      {
        mmsi: GUARDED,
        kinematics: {
          time: at,
          ...place(-30, -30),
          sog: 12,
          cog: 90,
          hdg: 511,
          navstatus: 0,
          predictedNavstatus: 0,
        },
        collision: {
          collisionRisk: 'medium',
          closestEncounter: { otherMmsi: PAIR_A, cpaNm: 0.2, tcpaMin: 9 },
          evaluatedAt: at,
        },
      },
    ]);
    // Older than the stored part, or a vessel without a stored state: nothing changes.
    expect(
      await repository.resetCollision([
        { mmsi: GUARDED, evaluatedAt: later(-1) },
        { mmsi: 525_870_029, evaluatedAt: later(10) },
      ]),
    ).toEqual([]);
    const [reset] = await repository.resetCollision([
      { mmsi: GUARDED, evaluatedAt: later(10) },
    ]);
    expect(reset?.state).toMatchObject({
      mmsi: GUARDED,
      time: later(10).toISOString(),
      collisionRisk: 'none',
      closestEncounter: null,
      methodIds: ['collision.cpa_tcpa'],
    });
    // Already none: not written (nor published) again.
    expect(
      await repository.resetCollision([
        { mmsi: GUARDED, evaluatedAt: later(20) },
      ]),
    ).toEqual([]);
  });
});
