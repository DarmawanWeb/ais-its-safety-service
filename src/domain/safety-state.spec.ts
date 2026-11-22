import type { SafetyVesselStateV1 } from '@darmawanweb/ais-its-contracts/events';
import { describe, expect, it } from 'vitest';

import {
  hidePipeline,
  isMaterialStateChange,
  mergeSafetyReports,
  publicationReason,
  type SafetyStateReport,
  safetyStateMethodIds,
} from './safety-state.js';

const kinematics = (seconds: number) => ({
  time: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)),
  lat: -6.9,
  lon: 112.7,
  sog: 0.1,
  cog: 10,
  hdg: 511,
  navstatus: 1,
  predictedNavstatus: 1 as const,
});

const state = (
  overrides: Partial<SafetyVesselStateV1> = {},
): SafetyVesselStateV1 => ({
  mmsi: 525005223,
  time: '2026-01-01T00:00:00.000Z',
  ewsStatus: 3,
  pipelineDistanceM: 2500,
  nearestPipelineZoneId: '0195f3c4-0000-7000-8000-000000000001',
  collisionRisk: 'none',
  closestEncounter: null,
  methodIds: ['ews.pipeline_distance_status', 'collision.cpa_tcpa'],
  ...overrides,
});

describe('mergeSafetyReports', () => {
  it('keeps the newest kinematics and the newest of each part', () => {
    const ewsPart = {
      ewsStatus: 1 as const,
      pipelineDistanceM: 900,
      nearestPipelineZoneId: 'z',
      nearestPipelineOrgId: null,
      evaluatedAt: kinematics(10).time,
    };
    const ews: SafetyStateReport = {
      mmsi: 525005223,
      kinematics: kinematics(10),
      ews: ewsPart,
    };
    const collision: SafetyStateReport = {
      mmsi: 525005223,
      kinematics: kinematics(5),
      collision: {
        collisionRisk: 'low',
        closestEncounter: null,
        evaluatedAt: kinematics(5).time,
      },
    };
    const merged = mergeSafetyReports(ews, collision);
    expect(merged.kinematics.time).toEqual(kinematics(10).time);
    expect(merged.ews?.ewsStatus).toBe(1);
    expect(merged.collision?.collisionRisk).toBe('low');

    const newerEws = mergeSafetyReports(merged, {
      ...ews,
      kinematics: kinematics(20),
      ews: { ...ewsPart, ewsStatus: 0, evaluatedAt: kinematics(20).time },
    });
    expect(newerEws.ews?.ewsStatus).toBe(0);
    expect(newerEws.collision?.collisionRisk).toBe('low');
  });
});

describe('safetyStateMethodIds', () => {
  it('lists the methods of the evaluated parts', () => {
    expect(safetyStateMethodIds({ ews: true, collision: false })).toEqual([
      'ews.pipeline_distance_status',
    ]);
    expect(safetyStateMethodIds({ ews: true, collision: true })).toEqual([
      'ews.pipeline_distance_status',
      'collision.cpa_tcpa',
    ]);
  });
});

describe('publicationReason (spec §13.7)', () => {
  const heartbeatMs = 300_000;

  it('publishes the first state', () => {
    expect(publicationReason(null, state(), heartbeatMs)).toBe('initial');
  });

  it('publishes on a change of status, risk, pipeline or encounter vessel', () => {
    expect(
      publicationReason(state(), state({ ewsStatus: 1 }), heartbeatMs),
    ).toBe('change');
    expect(
      publicationReason(state(), state({ collisionRisk: 'low' }), heartbeatMs),
    ).toBe('change');
    expect(
      publicationReason(
        state(),
        state({ nearestPipelineZoneId: null }),
        heartbeatMs,
      ),
    ).toBe('change');
    expect(
      publicationReason(
        state({
          collisionRisk: 'medium',
          closestEncounter: { otherMmsi: 1, cpaNm: 0.4, tcpaMin: 9 },
        }),
        state({
          collisionRisk: 'medium',
          closestEncounter: { otherMmsi: 2, cpaNm: 0.4, tcpaMin: 9 },
        }),
        heartbeatMs,
      ),
    ).toBe('change');
  });

  it('publishes material CPA/TCPA or distance changes of vessels at risk only', () => {
    const encounter = { otherMmsi: 1, cpaNm: 0.4, tcpaMin: 9 };
    const atRisk = state({
      collisionRisk: 'medium',
      closestEncounter: encounter,
    });
    expect(
      publicationReason(
        atRisk,
        { ...atRisk, closestEncounter: { ...encounter, tcpaMin: 7.5 } },
        heartbeatMs,
      ),
    ).toBe('change');
    expect(
      publicationReason(
        atRisk,
        { ...atRisk, closestEncounter: { ...encounter, tcpaMin: 8.5 } },
        heartbeatMs,
      ),
    ).toBeNull();
    const warned = state({ ewsStatus: 1, pipelineDistanceM: 1000 });
    expect(
      publicationReason(
        warned,
        { ...warned, pipelineDistanceM: 960 },
        heartbeatMs,
      ),
    ).toBe('change');
    expect(
      publicationReason(
        warned,
        { ...warned, pipelineDistanceM: 990 },
        heartbeatMs,
      ),
    ).toBeNull();
    // A safe vessel moving away from the pipeline is not a change.
    expect(
      publicationReason(
        state(),
        state({ pipelineDistanceM: 4000 }),
        heartbeatMs,
      ),
    ).toBeNull();
  });

  it('publishes an unchanged state again after the heartbeat (event time)', () => {
    expect(
      publicationReason(
        state(),
        state({ time: '2026-01-01T00:04:59.000Z' }),
        heartbeatMs,
      ),
    ).toBeNull();
    expect(
      publicationReason(
        state(),
        state({ time: '2026-01-01T00:05:00.000Z' }),
        heartbeatMs,
      ),
    ).toBe('heartbeat');
  });

  it('never publishes a state older than the published one', () => {
    expect(
      publicationReason(
        state({ time: '2026-01-01T00:10:00.000Z' }),
        state({ time: '2026-01-01T00:09:00.000Z', ewsStatus: 0 }),
        heartbeatMs,
      ),
    ).toBeNull();
  });

  it('treats a change of the evaluated methods as a change', () => {
    expect(
      isMaterialStateChange(
        state({ methodIds: ['ews.pipeline_distance_status'] }),
        state(),
      ),
    ).toBe(true);
  });
});

describe('hidePipeline (spec §8.5: org-owned zones are tenant-private)', () => {
  it('removes the zone and its distance, keeps the shared EWS status', () => {
    const warned = state({ ewsStatus: 1, pipelineDistanceM: 900 });
    expect(hidePipeline(warned)).toEqual({
      ...warned,
      pipelineDistanceM: null,
      nearestPipelineZoneId: null,
    });
    expect(warned.nearestPipelineZoneId).not.toBeNull();
  });
});
