import { createTestConfig } from '@darmawanweb/ais-its-nest/testing';
import type { SafetyVesselStateV1 } from '@darmawanweb/ais-its-contracts/events';
import { describe, expect, it } from 'vitest';

import { testMetrics } from '../../detectors/__testing__/fakes.js';
import { configSchema } from '../../config.js';
import {
  type CollisionReset,
  collisionResetPart,
  mergeSafetyReports,
  type SafetyStateReport,
  safetyStateMethodIds,
} from '../../domain/safety-state.js';
import type { SafetyStatePublication } from './safety-state.publisher.js';
import {
  type SafetyStateStore,
  SafetyStateWriter,
} from './safety-state.writer.js';
import type { StoredSafetyState } from './vessel-states.repository.js';

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

const report = (
  mmsi: number,
  seconds: number,
  ewsStatus: 0 | 1 | 3 = 3,
): SafetyStateReport => ({
  mmsi,
  kinematics: {
    time: at(seconds),
    lat: -6.9,
    lon: 112.7,
    sog: 0.1,
    cog: 0,
    hdg: 511,
    navstatus: 1,
    predictedNavstatus: 1,
  },
  ews: {
    ewsStatus,
    pipelineDistanceM: 800,
    nearestPipelineZoneId: null,
    nearestPipelineOrgId: null,
    evaluatedAt: at(seconds),
  },
});

/** A report carrying the collision part only (`risk` evaluated at `seconds`). */
const collisionReport = (
  mmsi: number,
  seconds: number,
  risk: 'none' | 'low' | 'medium' | 'high',
): SafetyStateReport => ({
  mmsi,
  kinematics: {
    time: at(seconds),
    lat: -6.9,
    lon: 112.7,
    sog: 12,
    cog: 90,
    hdg: 511,
    navstatus: 0,
    predictedNavstatus: 0,
  },
  collision: {
    collisionRisk: risk,
    closestEncounter:
      risk === 'none' ? null : { otherMmsi: 525005299, cpaNm: 0.1, tcpaMin: 6 },
    evaluatedAt: at(seconds),
  },
});

/** The state of a stored row (`evaluated_at` = the newest of its times). */
const stateOf = (report: SafetyStateReport): SafetyVesselStateV1 => ({
  mmsi: report.mmsi,
  time: new Date(
    Math.max(
      report.kinematics.time.getTime(),
      report.ews?.evaluatedAt.getTime() ?? 0,
      report.collision?.evaluatedAt.getTime() ?? 0,
    ),
  ).toISOString(),
  ewsStatus: report.ews?.ewsStatus ?? 3,
  pipelineDistanceM: report.ews?.pipelineDistanceM ?? null,
  nearestPipelineZoneId: null,
  collisionRisk: report.collision?.collisionRisk ?? 'none',
  closestEncounter: report.collision?.closestEncounter ?? null,
  methodIds: safetyStateMethodIds({
    ews: report.ews !== undefined,
    collision: report.collision !== undefined,
  }),
});

/** An in-memory `vessel_state`: merges like the SQL writes (newest part wins). */
class MemoryStore implements SafetyStateStore {
  readonly rows = new Map<
    number,
    { report: SafetyStateReport; published: SafetyVesselStateV1 | null }
  >();
  failures = 0;
  upserts = 0;
  /** The batches of `resetCollision`, failed ones included. */
  readonly resetBatches: CollisionReset[][] = [];
  /** The writes in order. */
  readonly calls: ('upsert' | 'reset')[] = [];
  /** Runs at the start of every upsert (reports queued meanwhile). */
  onUpsert: () => void = () => undefined;

  upsertReports(
    reports: readonly SafetyStateReport[],
  ): Promise<StoredSafetyState[]> {
    this.upserts += 1;
    this.calls.push('upsert');
    this.onUpsert();
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('database unavailable'));
    }
    return Promise.resolve(
      reports.map((incoming) => {
        const row = this.rows.get(incoming.mmsi);
        const merged =
          row === undefined
            ? incoming
            : mergeSafetyReports(row.report, incoming);
        this.rows.set(incoming.mmsi, {
          report: merged,
          published: row?.published ?? null,
        });
        return { state: stateOf(merged), published: row?.published ?? null };
      }),
    );
  }

  /** Like `RESET_COLLISION_SQL`: existing rows whose part is not newer and not `none`. */
  resetCollision(
    resets: readonly CollisionReset[],
  ): Promise<StoredSafetyState[]> {
    this.resetBatches.push([...resets]);
    this.calls.push('reset');
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('database unavailable'));
    }
    const changed: StoredSafetyState[] = [];
    for (const reset of resets) {
      const row = this.rows.get(reset.mmsi);
      const part = row?.report.collision;
      if (
        row === undefined ||
        part === undefined ||
        part.collisionRisk === 'none' ||
        part.evaluatedAt.getTime() > reset.evaluatedAt.getTime()
      )
        continue;
      const report = { ...row.report, collision: collisionResetPart(reset) };
      this.rows.set(reset.mmsi, { report, published: row.published });
      changed.push({ state: stateOf(report), published: row.published });
    }
    return Promise.resolve(changed);
  }

  markPublished(states: readonly SafetyVesselStateV1[]): Promise<void> {
    for (const state of states) {
      const row = this.rows.get(state.mmsi);
      if (row !== undefined) row.published = state;
    }
    return Promise.resolve();
  }
}

class RecordingPublisher implements SafetyStatePublication {
  readonly published: SafetyVesselStateV1[] = [];
  failNext = false;

  publish(state: SafetyVesselStateV1): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('NATS unavailable'));
    }
    this.published.push(state);
    return Promise.resolve();
  }
}

function setup() {
  const store = new MemoryStore();
  const publisher = new RecordingPublisher();
  const config = createTestConfig(configSchema, {
    SAFETY_STATE_HEARTBEAT_S: '300',
  });
  const writer = new SafetyStateWriter(store, publisher, testMetrics(), config);
  return { store, publisher, writer };
}

describe('SafetyStateWriter', () => {
  it('merges the reports of a vessel and writes them in one batch', async () => {
    const { store, publisher, writer } = setup();
    writer.report(report(525005223, 0));
    writer.report(report(525005223, 10, 1));
    writer.report(report(525005224, 5));
    expect(writer.pendingCount).toBe(2);

    await writer.flush();

    expect(store.upserts).toBe(1);
    expect(
      publisher.published.map((state) => [state.mmsi, state.ewsStatus]),
    ).toEqual([
      [525005223, 1],
      [525005224, 3],
    ]);
    expect(writer.pendingCount).toBe(0);
  });

  it('publishes on change and on the heartbeat only', async () => {
    const { publisher, writer } = setup();
    writer.report(report(525005223, 0));
    await writer.flush();
    writer.report(report(525005223, 60));
    await writer.flush();
    expect(publisher.published).toHaveLength(1); // unchanged within the heartbeat

    writer.report(report(525005223, 120, 1));
    await writer.flush();
    writer.report(report(525005223, 420, 1)); // 300 s after the last publication
    await writer.flush();
    expect(
      publisher.published.map((state) => [state.time, state.ewsStatus]),
    ).toEqual([
      ['2026-01-01T00:00:00.000Z', 3],
      ['2026-01-01T00:02:00.000Z', 1],
      ['2026-01-01T00:07:00.000Z', 1],
    ]);
  });

  it('keeps reports of a failed write and retries them, newer reports winning', async () => {
    const { store, publisher, writer } = setup();
    store.failures = 1;
    writer.report(report(525005223, 0));
    await writer.flush();
    expect(publisher.published).toEqual([]);
    expect(writer.pendingCount).toBe(1);

    writer.report(report(525005223, 10, 0));
    await writer.flush();
    expect(publisher.published.map((state) => state.ewsStatus)).toEqual([0]);
    expect(writer.pendingCount).toBe(0);
  });

  it('retries a failed publication with the next report', async () => {
    const { publisher, writer } = setup();
    publisher.failNext = true;
    writer.report(report(525005223, 0));
    await writer.flush();
    expect(publisher.published).toEqual([]);

    writer.report(report(525005223, 10));
    await writer.flush();
    expect(publisher.published).toHaveLength(1);
  });

  describe('collision resets (a band no evaluation backs any more)', () => {
    const VESSEL = 525005230;
    const reset = (mmsi: number, seconds: number): CollisionReset => ({
      mmsi,
      evaluatedAt: at(seconds),
    });
    const bands = (publisher: RecordingPublisher, mmsi: number) =>
      publisher.published
        .filter((state) => state.mmsi === mmsi)
        .map((state) => [state.time, state.collisionRisk]);

    it('writes a reset after the reports and publishes the fallen-back state', async () => {
      const { store, publisher, writer } = setup();
      writer.report(collisionReport(VESSEL, 0, 'high'));
      await writer.flush();

      writer.resetCollision(reset(VESSEL, 30));
      writer.resetCollision(reset(VESSEL, 20)); // older: the newer reset stays
      writer.resetCollision(reset(525005231, 30)); // no stored state: left alone
      expect(writer.pendingCount).toBe(2);
      await writer.flush();

      expect(store.upserts).toBe(1);
      expect(store.resetBatches).toEqual([
        [reset(VESSEL, 30), reset(525005231, 30)],
      ]);
      expect(bands(publisher, VESSEL)).toEqual([
        ['2026-01-01T00:00:00.000Z', 'high'],
        ['2026-01-01T00:00:30.000Z', 'none'],
      ]);
      expect(publisher.published.at(-1)?.closestEncounter).toBeNull();
      expect(bands(publisher, 525005231)).toEqual([]);
      expect(writer.pendingCount).toBe(0);

      // A newer stored part is kept, an older reset changes nothing.
      writer.report(collisionReport(VESSEL, 60, 'medium'));
      await writer.flush();
      writer.resetCollision(reset(VESSEL, 45));
      await writer.flush();
      expect(bands(publisher, VESSEL).at(-1)).toEqual([
        '2026-01-01T00:01:00.000Z',
        'medium',
      ]);
    });

    it('merges a reset with a pending report of the vessel: the newest part wins, the later call on a tie', async () => {
      const { store, publisher, writer } = setup();
      // The reset follows the report at the same event time: it wins.
      writer.report(collisionReport(VESSEL, 10, 'high'));
      writer.resetCollision(reset(VESSEL, 10));
      // A report following a reset at the same event time wins.
      writer.resetCollision(reset(525005231, 10));
      writer.report(collisionReport(525005231, 10, 'medium'));
      // An older reset loses against a pending report.
      writer.report(collisionReport(525005232, 20, 'high'));
      writer.resetCollision(reset(525005232, 15));
      expect(writer.pendingCount).toBe(3);
      await writer.flush();

      expect(store.upserts).toBe(1);
      expect(store.resetBatches).toEqual([]);
      expect(
        publisher.published.map((state) => [state.mmsi, state.collisionRisk]),
      ).toEqual([
        [VESSEL, 'none'],
        [525005231, 'medium'],
        [525005232, 'high'],
      ]);
    });

    it('writes the resets in every round, however many reports keep arriving', async () => {
      const { store, writer } = setup();
      writer.report(collisionReport(VESSEL, 0, 'high'));
      await writer.flush();

      // Every write of reports finds a report of another vessel queued meanwhile.
      let next = 525005240;
      store.onUpsert = () => {
        if (next < 525005245) writer.report(report(next++, 0));
      };
      writer.report(report(next++, 0));
      writer.resetCollision(reset(VESSEL, 30));
      await writer.flush();

      expect(store.calls).toEqual([
        'upsert', // the first flush
        'upsert',
        'reset', // in the first round, not once the reports ran dry
        'upsert',
        'upsert',
        'upsert',
        'upsert',
      ]);
      expect(store.rows.get(VESSEL)?.report.collision?.collisionRisk).toBe(
        'none',
      );
    });

    it('keeps a failed reset and retries it, a newer report of the vessel winning', async () => {
      const { store, publisher, writer } = setup();
      writer.report(collisionReport(VESSEL, 0, 'high'));
      writer.report(collisionReport(525005231, 0, 'high'));
      await writer.flush();

      store.failures = 1;
      writer.resetCollision(reset(VESSEL, 30));
      writer.resetCollision(reset(525005231, 30));
      await writer.flush();
      expect(writer.pendingCount).toBe(2);

      writer.report(collisionReport(525005231, 30, 'medium'));
      await writer.flush();
      expect(writer.pendingCount).toBe(0);
      expect(bands(publisher, VESSEL).at(-1)).toEqual([
        '2026-01-01T00:00:30.000Z',
        'none',
      ]);
      expect(bands(publisher, 525005231).at(-1)).toEqual([
        '2026-01-01T00:00:30.000Z',
        'medium',
      ]);
      expect(store.resetBatches).toEqual([
        [reset(VESSEL, 30), reset(525005231, 30)],
        [reset(VESSEL, 30)],
      ]);
    });
  });
});
