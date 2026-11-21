import { DetectorTestHarness } from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it } from 'vitest';

import {
  RecordingEncounterSink,
  RecordingStateSink,
  testMetrics,
} from '../__testing__/fakes.js';
import { CollisionDetector } from './collision.detector.js';

const LAT0 = -6.9;
const LON0 = 112.75;
/** A position `x` nm east and `y` nm north of (LAT0, LON0) on the local plane. */
const place = (x: number, y: number) => ({
  lat: LAT0 + y / 60,
  lon: LON0 + x / (60 * Math.cos((LAT0 * Math.PI) / 180)),
});
const T0 = new Date('2026-01-01T00:00:00.000Z');
const after = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const A = 525_000_001;
const B = 525_000_002;
const KEY = `collision:${A}:${B}`;
const underWay = { navstatus: 0, predictedNavstatus: 0 as const, hdg: 511 };

function setup(env: Record<string, string> = {}) {
  const states = new RecordingStateSink();
  const encounters = new RecordingEncounterSink();
  const harness = DetectorTestHarness.create({
    detectors: [new CollisionDetector(states, encounters, testMetrics())],
    distanceModel: 'sphere',
    pairSearch: { cellSizeM: 3704, maxAgeMs: 600_000 },
    env,
    now: T0,
  });
  return { harness, states, encounters };
}

/**
 * A crosses northwards at 12 kn, B westwards at 12 kn; both reach (0, 2) nm
 * 10 min after T0: CPA 0, TCPA 10 min (medium), then 5 min later TCPA 5 min (high).
 */
async function crossing(harness: DetectorTestHarness, minutes = 0) {
  const s = minutes * 60;
  await harness.position({
    mmsi: A,
    ...place(0, minutes / 5),
    sog: 12,
    cog: 0,
    time: after(s),
    ...underWay,
  });
  await harness.position({
    mmsi: B,
    ...place(2 - minutes / 5, 2),
    sog: 12,
    cog: 270,
    time: after(s + 1),
    ...underWay,
  });
}

describe('CollisionDetector', () => {
  it('raises a warning for a medium-risk crossing and reports both vessels', async () => {
    const { harness, states, encounters } = setup();
    await crossing(harness);

    expect(harness.alertsOf('collision')).toEqual([
      expect.objectContaining({
        type: 'collision',
        domain: 'safety',
        severity: 'warning',
        mmsi: A,
        relatedMmsi: B,
        dedupKey: KEY,
        methodId: 'collision.cpa_tcpa',
        data: expect.objectContaining({
          methodId: 'collision.cpa_tcpa',
          risk: 'medium',
          cpaNm: expect.closeTo(0, 1) as unknown,
          tcpaMin: expect.closeTo(10, 0) as unknown,
          encounterId: expect.any(String) as unknown,
        }) as unknown,
      }),
    ]);
    for (const [mmsi, other] of [
      [A, B],
      [B, A],
    ] as const) {
      expect(states.last(mmsi)?.collision).toMatchObject({
        collisionRisk: 'medium',
        closestEncounter: { otherMmsi: other },
      });
    }
    expect(encounters.samples).toEqual([
      expect.objectContaining({ mmsiA: A, mmsiB: B, risk: 'medium' }),
    ]);
  });

  it('does not repeat while the band holds, escalates to critical, resolves once the vessels pass', async () => {
    const { harness, states, encounters } = setup();
    // Reports every 30 s from T0 until 12.5 min, past the crossing at 10 min.
    for (let minutes = 0; minutes <= 12.5; minutes += 0.5)
      await crossing(harness, minutes);

    expect(
      harness.alertsOf('collision').map((alert) => alert.severity),
    ).toEqual(['warning', 'critical']);
    expect(harness.resolutions).toEqual([
      expect.objectContaining({
        alert: expect.objectContaining({ dedupKey: KEY }) as unknown,
        reason: expect.stringMatching(/^risk none/) as unknown,
      }),
    ]);
    expect(states.last(A)?.collision).toMatchObject({
      collisionRisk: 'none',
      closestEncounter: null,
    });
    expect(states.last(B)?.collision).toMatchObject({
      collisionRisk: 'none',
      closestEncounter: null,
    });
    const risks = encounters.samples.map((sample) => sample.risk);
    expect(risks[0]).toBe('medium');
    expect(risks).toContain('high');
    expect(risks.at(-1)).toBe('none');
    expect(
      new Set(encounters.samples.map((sample) => sample.encounterId)).size,
    ).toBe(1);
  });

  it.each([
    ['predicted at anchor', { predictedNavstatus: 1 as const }],
    ['moored', { navstatus: 5 }],
    ['SOG not available', { sog: 102.3 }],
    ['COG not available', { cog: 360 }],
    ['slower than 0.5 kn', { sog: 0.4 }],
  ])('excludes a pair when one vessel is %s', async (_label, override) => {
    const { harness, states } = setup();
    await harness.position({
      mmsi: A,
      ...place(0, 0),
      sog: 12,
      cog: 0,
      time: T0,
      ...underWay,
    });
    await harness.position({
      mmsi: B,
      ...place(2, 2),
      sog: 12,
      cog: 270,
      time: after(1),
      ...underWay,
      ...override,
    });
    expect(harness.alerts).toEqual([]);
    expect(states.last(B)?.collision?.collisionRisk).toBe('none');
  });

  it('ignores candidates beyond the search radius or not seen within the window', async () => {
    const { harness } = setup();
    // 7 nm east, heading west at 30 kn: CPA 0 but outside COLLISION_SEARCH_RADIUS_NM = 6.
    await harness.position({
      mmsi: A,
      ...place(0, 0),
      sog: 10,
      cog: 90,
      time: T0,
      ...underWay,
    });
    await harness.position({
      mmsi: B,
      ...place(7, 0),
      sog: 30,
      cog: 270,
      time: after(1),
      ...underWay,
    });
    expect(harness.alerts).toEqual([]);

    // Seen 3 min before (window 2 min).
    await harness.position({
      mmsi: A + 10,
      ...place(0, 10),
      sog: 12,
      cog: 0,
      time: after(10),
      ...underWay,
    });
    await harness.position({
      mmsi: B + 10,
      ...place(2, 12),
      sog: 12,
      cog: 270,
      time: after(190),
      ...underWay,
    });
    expect(harness.alerts).toEqual([]);
  });

  it('closes pairs that stopped reporting on the tick (event time)', async () => {
    const { harness, states } = setup();
    await crossing(harness);
    expect(harness.alertsOf('collision')).toHaveLength(1);

    // Another vessel far away moves the event time 3 min on.
    await harness.position({
      mmsi: 525_000_099,
      ...place(50, 50),
      sog: 8,
      cog: 0,
      time: after(181),
      ...underWay,
    });
    await harness.tick(after(181));

    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'not evaluated for 120 s' }),
    ]);
    expect(states.last(A)?.collision?.collisionRisk).toBe('none');
    expect(states.last(B)?.collision?.collisionRisk).toBe('none');
  });

  it('describes its thresholds', () => {
    const { harness } = setup({ COLLISION_SEARCH_RADIUS_NM: '4' });
    expect(harness.describe()).toEqual([
      expect.objectContaining({
        id: 'collision',
        methodIds: ['collision.cpa_tcpa'],
        alertTypes: ['collision'],
        tickIntervalMs: 30_000,
        config: expect.objectContaining({
          SEARCH_RADIUS_NM: 4,
          MAX_AGE_S: 120,
          MIN_SOG_KN: 0.5,
          HIGH_CPA_NM: 0.25,
          HIGH_TCPA_MIN: 6,
          MEDIUM_CPA_NM: 0.5,
          MEDIUM_TCPA_MIN: 12,
          LOW_CPA_NM: 1,
          LOW_TCPA_MIN: 20,
          HYSTERESIS: 0.2,
        }) as unknown,
      }),
    ]);
  });

  it('refuses bands that do not grow from high to low', () => {
    expect(() => setup({ COLLISION_HIGH_CPA_NM: '0.8' })).toThrow(
      /COLLISION_HIGH_CPA_NM/,
    );
  });
});
