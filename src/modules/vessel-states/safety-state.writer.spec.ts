import { createTestConfig } from '@darmawanweb/ais-its-nest/testing';
import type { SafetyVesselStateV1 } from '@darmawanweb/ais-its-contracts/events';
import { describe, expect, it } from 'vitest';

import { testMetrics } from '../../detectors/__testing__/fakes.js';
import { configSchema } from '../../config.js';
import type { SafetyStateReport } from '../../domain/safety-state.js';
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
    evaluatedAt: at(seconds),
  },
});

/** An in-memory `vessel_state`: merges like the SQL upsert (newest part wins). */
class MemoryStore implements SafetyStateStore {
  readonly rows = new Map<
    number,
    { report: SafetyStateReport; published: SafetyVesselStateV1 | null }
  >();
  failures = 0;
  upserts = 0;

  upsertReports(
    reports: readonly SafetyStateReport[],
  ): Promise<StoredSafetyState[]> {
    this.upserts += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('database unavailable'));
    }
    return Promise.resolve(
      reports.map((incoming) => {
        const row = this.rows.get(incoming.mmsi);
        const merged =
          row === undefined ||
          row.report.kinematics.time <= incoming.kinematics.time
            ? incoming
            : row.report;
        this.rows.set(incoming.mmsi, {
          report: merged,
          published: row?.published ?? null,
        });
        return {
          state: {
            mmsi: merged.mmsi,
            time: merged.kinematics.time.toISOString(),
            ewsStatus: merged.ews?.ewsStatus ?? 3,
            pipelineDistanceM: merged.ews?.pipelineDistanceM ?? null,
            nearestPipelineZoneId: null,
            collisionRisk: 'none',
            closestEncounter: null,
            methodIds: ['ews.pipeline_distance_status'],
          },
          published: row?.published ?? null,
        };
      }),
    );
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
});
