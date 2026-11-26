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

const MINUTE = 60_000;
/** The runner's default alert cooldown (`ALERT_COOLDOWN_S` = 600). */
const COOLDOWN_MS = 10 * MINUTE;

function setup(env: Record<string, string> = {}) {
  const states = new RecordingStateSink();
  const encounters = new RecordingEncounterSink();
  const harness = DetectorTestHarness.create({
    detectors: [new CollisionDetector(states, encounters, testMetrics())],
    distanceModel: 'sphere',
    pairSearch: { cellSizeM: 3704, maxAgeMs: 600_000 },
    alertCooldownMs: COOLDOWN_MS,
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
      expect.objectContaining({
        reason: 'not evaluated for 120 s',
        data: {
          risk: 'none',
          messageKey: 'safety.collision.resolved_stale',
          messageParams: { maxAgeS: 120 },
        },
      }),
    ]);
    expect(states.last(A)?.collision?.collisionRisk).toBe('none');
    expect(states.last(B)?.collision?.collisionRisk).toBe('none');
  });

  it('resolves an open alert whose pair is not evaluated again within the window of event time, whatever the wall clock', async () => {
    const { harness } = setup();
    // The wall clock runs a day ahead of the AIS event time (a backlog).
    harness.setTime(new Date(T0.getTime() + 86_400_000));
    harness.services.alerts.restore([
      {
        alertId: '0195f3c4-0000-7000-8000-0000000000c1',
        dedupKey: KEY,
        type: 'collision',
        mmsi: A,
        relatedMmsi: B,
        zoneId: null,
        severity: 'warning',
        publishedSeverity: 'warning',
        openedAt: harness.now,
        publishedAt: harness.now,
        lastSeenAt: harness.now,
        // Event times of the occurrence (events.opened_at / last_seen_at).
        firstOccurredAt: after(-90),
        lastOccurredAt: after(-30),
        detector: 'collision',
      },
    ]);
    const far = { sog: 8, cog: 0, ...underWay };
    await harness.position({
      mmsi: 525_000_099,
      ...place(50, 50),
      ...far,
      time: after(0),
    });
    await harness.tick();
    expect(harness.resolutions).toEqual([]);

    await harness.position({
      mmsi: 525_000_099,
      ...place(50, 51),
      ...far,
      time: after(130),
    });
    await harness.tick();
    expect(harness.resolutions).toEqual([
      expect.objectContaining({
        reason: 'pair no longer evaluated',
        data: {
          messageKey: 'safety.collision.resolved_not_evaluated',
          messageParams: {},
        },
      }),
    ]);
  });

  it('gives restored alerts the window after the first position of the active period', async () => {
    const { harness } = setup();
    // Last signal 10 min before the feed resumes (an outage of the service).
    harness.services.alerts.restore([
      {
        alertId: '0195f3c4-0000-7000-8000-0000000000c2',
        dedupKey: KEY,
        type: 'collision',
        mmsi: A,
        relatedMmsi: B,
        zoneId: null,
        severity: 'warning',
        publishedSeverity: 'warning',
        openedAt: after(-660),
        publishedAt: after(-660),
        lastSeenAt: after(-600),
        firstOccurredAt: after(-660),
        lastOccurredAt: after(-600),
        detector: 'collision',
      },
    ]);
    await harness.activate();
    const far = { sog: 8, cog: 0, ...underWay };
    await harness.position({
      mmsi: 525_000_099,
      ...place(50, 50),
      ...far,
      time: after(0),
    });
    await harness.tick();
    // The pair may still report: nothing is resolved before the window ends.
    expect(harness.resolutions).toEqual([]);
    await crossing(harness);
    expect(harness.alertsOf('collision')).toEqual([]);
    expect(harness.services.alerts.get(KEY)?.alertId).toBe(
      '0195f3c4-0000-7000-8000-0000000000c2',
    );
  });

  it('falls back the stored bands of a restored pair it never evaluates again, except for vessels it follows', async () => {
    const { harness, states } = setup();
    // The previous active instance raised A–X; X never reports to this one.
    const X = 525_000_003;
    const orphan = `collision:${A}:${X}`;
    harness.services.alerts.restore([
      {
        alertId: '0195f3c4-0000-7000-8000-0000000000c3',
        dedupKey: orphan,
        type: 'collision',
        mmsi: A,
        relatedMmsi: X,
        zoneId: null,
        severity: 'critical',
        publishedSeverity: 'critical',
        openedAt: after(-660),
        publishedAt: after(-660),
        lastSeenAt: after(-600),
        firstOccurredAt: after(-660),
        lastOccurredAt: after(-600),
        detector: 'collision',
      },
    ]);
    await harness.activate();
    const far = { sog: 8, cog: 0, ...underWay };
    await harness.position({
      mmsi: 525_000_099,
      ...place(50, 50),
      ...far,
      time: after(0),
    });
    await harness.tick();
    // Within the window of the active period the pair may still report.
    expect(harness.resolutions).toEqual([]);
    expect(states.resets).toEqual([]);

    // A crosses B at medium risk (followed here); X stays silent.
    await crossing(harness, 2);
    await harness.tick();
    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'pair no longer evaluated' }),
    ]);
    expect(harness.services.alerts.isOpen(orphan)).toBe(false);
    // A's band is this instance's (medium, reported); X falls back.
    expect(states.resets).toEqual([{ mmsi: X, evaluatedAt: after(121) }]);
    expect(states.last(A)?.collision?.collisionRisk).toBe('medium');

    // A later report of X wins over the reset, even with an older AIS time.
    await harness.position({
      mmsi: X,
      ...place(30, 30),
      ...far,
      time: after(100),
    });
    expect(states.last(X)?.collision).toEqual({
      collisionRisk: 'none',
      closestEncounter: null,
      evaluatedAt: after(121),
    });
  });

  it('falls back the neighbour of a restored pair evaluated without risk', async () => {
    const { harness, states } = setup();
    harness.services.alerts.restore([
      {
        alertId: '0195f3c4-0000-7000-8000-0000000000c4',
        dedupKey: KEY,
        type: 'collision',
        mmsi: A,
        relatedMmsi: B,
        zoneId: null,
        severity: 'warning',
        publishedSeverity: 'warning',
        openedAt: after(-90),
        publishedAt: after(-90),
        lastSeenAt: after(-30),
        firstOccurredAt: after(-90),
        lastOccurredAt: after(-30),
        detector: 'collision',
      },
    ]);
    await harness.activate();
    // Diverging: A sails north, B east from 2 nm east of A.
    await harness.position({
      mmsi: A,
      ...place(0, 0),
      sog: 12,
      cog: 0,
      time: after(0),
      ...underWay,
    });
    await harness.position({
      mmsi: B,
      ...place(2, 0),
      sog: 12,
      cog: 90,
      time: after(1),
      ...underWay,
    });
    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'no collision risk' }),
    ]);
    // B, the evaluated vessel, is reported; A, its neighbour, falls back.
    expect(states.resets).toEqual([{ mmsi: A, evaluatedAt: after(1) }]);
    expect(states.last(B)?.collision?.collisionRisk).toBe('none');
  });

  it('starts over after a takeover: new encounter, alert kept open without a new publication', async () => {
    const { harness, encounters } = setup();
    await crossing(harness);
    expect(harness.alertsOf('collision')).toHaveLength(1);
    const before = encounters.samples.at(-1)?.encounterId;

    // Another instance was active; this one takes over (onActivated).
    await harness.deactivate();
    await harness.activate();
    await crossing(harness, 1);

    expect(harness.alertsOf('collision')).toHaveLength(1);
    expect(harness.alertsOf('collision')[0]?.data).not.toHaveProperty('orgIds');
    const after = encounters.samples.at(-1)?.encounterId;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(harness.services.alerts.get(KEY)).toMatchObject({
      severity: 'warning',
      lastOccurredAt: new Date(T0.getTime() + 61_000),
    });
    expect(harness.resolutions).toEqual([]);
  });

  it('carries the localizable text of the alert (messageKey, messageParams)', async () => {
    const { harness } = setup();
    await harness.vessel({ mmsi: A, name: 'KM Alpha' });
    await crossing(harness);
    const [alert] = harness.alertsOf('collision');
    expect(alert?.title).toBe(
      `Medium risk of collision: KM Alpha (MMSI ${A}) and MMSI ${B}`,
    );
    expect(alert?.data).toMatchObject({
      messageKey: 'safety.collision.risk',
      messageParams: {
        vesselA: `KM Alpha (MMSI ${A})`,
        mmsiA: A,
        vesselB: `MMSI ${B}`,
        mmsiB: B,
        risk: 'medium',
        cpaNm: expect.closeTo(0, 2) as unknown,
        tcpaMin: expect.closeTo(10, 0) as unknown,
        rangeNm: expect.closeTo(2.83, 1) as unknown,
      },
    });
    const data = alert?.data as {
      cpaNm: number;
      rangeNm: number;
      messageParams: Record<string, unknown>;
    };
    const params = data.messageParams;
    for (const value of Object.values(params))
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    // Distances in whole metres (cross-service convention), next to the nm of the English text.
    expect(params.cpaM).toBe(Math.round(data.cpaNm * 1852));
    expect(params.rangeM).toBe(Math.round(data.rangeNm * 1852));
    expect(params.rangeM).toBeGreaterThan(5000);
  });

  it('publishes one alert.resolved.v1 once the cooldown since the last raise is over', async () => {
    const { harness } = setup();
    for (let minutes = 0; minutes <= 12.5; minutes += 0.5)
      await crossing(harness, minutes);
    const raised = harness.alertsOf('collision');
    expect(raised.map((alert) => alert.severity)).toEqual([
      'warning',
      'critical',
    ]);
    expect(harness.resolutions).toHaveLength(1);
    // Resolved within the cooldown of the escalation: the event waits.
    await harness.maintain();
    expect(harness.resolvedEvents).toEqual([]);

    harness.advance(COOLDOWN_MS);
    await harness.maintain();
    await harness.maintain();
    expect(harness.resolvedEvents).toEqual([
      expect.objectContaining({
        alertId: raised[1]?.id,
        type: 'collision',
        domain: 'safety',
        severity: 'critical',
        mmsi: A,
        relatedMmsi: B,
        dedupKey: KEY,
        methodId: 'collision.cpa_tcpa',
        reason: expect.stringMatching(/^risk none \(CPA/) as unknown,
        data: expect.objectContaining({
          risk: 'none',
          messageKey: 'safety.collision.resolved_risk',
          messageParams: expect.objectContaining({ risk: 'none' }) as unknown,
        }) as unknown,
      }),
    ]);
    const resolution = harness.resolvedEvents[0]?.data as {
      cpaNm: number;
      messageParams: Record<string, unknown>;
    };
    expect(resolution.messageParams.cpaM).toBe(
      Math.round(resolution.cpaNm * 1852),
    );
    expect(resolution.messageParams.cpaNm).toBe(
      Math.round(resolution.cpaNm * 100) / 100,
    );
  });

  it('publishes no resolution when the pair is at risk again within the cooldown', async () => {
    const { harness } = setup();
    await crossing(harness);
    expect(harness.alertsOf('collision')).toHaveLength(1);
    // B is excluded (moored) for a moment: the occurrence is resolved ...
    await harness.position({
      mmsi: B,
      ...place(2 - 1 / 5, 2),
      sog: 12,
      cog: 270,
      time: after(61),
      ...underWay,
      navstatus: 5,
    });
    expect(harness.resolutions).toEqual([
      expect.objectContaining({
        reason: `vessel ${B} excluded (stationary_navstatus)`,
        data: {
          risk: 'none',
          messageKey: 'safety.collision.resolved_excluded',
          messageParams: { mmsi: B, exclusion: 'stationary_navstatus' },
        },
      }),
    ]);
    // ... and raised again one minute later, within the cooldown.
    harness.advance(MINUTE);
    await crossing(harness, 2);
    expect(harness.alertsOf('collision')).toHaveLength(1);
    expect(harness.services.alerts.isOpen(KEY)).toBe(true);

    harness.advance(COOLDOWN_MS);
    await harness.maintain();
    expect(harness.resolvedEvents).toEqual([]);
  });

  it('runs its housekeeping only while active, from the first position of the active period', async () => {
    const { harness } = setup();
    await crossing(harness);
    const far = { sog: 8, cog: 0, ...underWay };
    const probe = (seconds: number) =>
      harness.position({
        mmsi: 525_000_099,
        ...place(50, 50 + seconds / 3600),
        ...far,
        time: after(seconds),
      });
    await harness.deactivate();
    await probe(400);
    await harness.tick();
    expect(harness.resolutions).toEqual([]);

    // Taking over: the tracker starts over, the open alert gets the window.
    await harness.activate();
    await probe(410);
    await harness.tick();
    expect(harness.resolutions).toEqual([]);
    await probe(540);
    await harness.tick();
    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'pair no longer evaluated' }),
    ]);
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
