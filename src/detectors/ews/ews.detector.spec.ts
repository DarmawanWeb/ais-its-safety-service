import type { GeoJsonGeometry } from '@darmawanweb/ais-its-contracts/domain';
import { ConfigValidationError } from '@darmawanweb/ais-its-nest';
import {
  destinationPoint,
  DetectorTestHarness,
} from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it } from 'vitest';

import {
  RecordingSightings,
  RecordingStateSink,
  TestGate,
} from '../__testing__/fakes.js';
import { EwsDetector } from './ews.detector.js';

/** A north–south pipeline along 112.70°E from 6.90°S to 6.80°S. */
const LINE: GeoJsonGeometry = {
  type: 'LineString',
  coordinates: [
    [112.7, -6.9],
    [112.7, -6.8],
  ],
};
const ON_LINE = { lat: -6.85, lon: 112.7 };
/** A point `meters` east of the pipeline (exact on the sphere). */
const east = (meters: number) => destinationPoint(ON_LINE, 90, meters);

const MMSI = 525_005_223;
const anchored = {
  navstatus: 1,
  predictedNavstatus: 1 as const,
  sog: 0.1,
  cog: 12,
};

function setup(env: Record<string, string> = {}) {
  const states = new RecordingStateSink();
  const gate = new TestGate();
  const sightings = new RecordingSightings();
  const harness = DetectorTestHarness.create({
    detectors: [new EwsDetector(states, gate, sightings)],
    distanceModel: 'sphere',
    env,
  });
  return { harness, states, gate, sightings };
}

describe('EwsDetector', () => {
  it('raises a warning on entering the warning band, with the method and thresholds', async () => {
    const { harness } = setup();
    const zone = await harness.zone({
      kind: 'pipeline',
      name: 'Test pipeline',
      geometry: LINE,
    });

    await harness.position({ mmsi: MMSI, ...east(1000), ...anchored });

    expect(harness.alertsOf('ews')).toEqual([
      expect.objectContaining({
        type: 'ews',
        domain: 'safety',
        severity: 'warning',
        mmsi: MMSI,
        zoneId: zone.id,
        dedupKey: `ews:${MMSI}:${zone.id}`,
        methodId: 'ews.pipeline_distance_status',
        data: expect.objectContaining({
          methodId: 'ews.pipeline_distance_status',
          ewsStatus: 1,
          zoneId: zone.id,
          thresholds: { dangerM: 500, warningM: 1750 },
          pipelineDistanceM: expect.closeTo(1000, 3) as unknown,
        }) as unknown,
      }),
    ]);
  });

  it('does not repeat while unchanged, escalates to danger, de-escalates silently and resolves when safe', async () => {
    const { harness } = setup();
    await harness.zone({ kind: 'pipeline', geometry: LINE });

    await harness.position({ mmsi: MMSI, ...east(1000), ...anchored });
    await harness.position({ mmsi: MMSI, ...east(1010), ...anchored });
    expect(harness.alertsOf('ews')).toHaveLength(1);

    await harness.position({ mmsi: MMSI, ...east(300), ...anchored });
    expect(harness.alertsOf('ews').map((alert) => alert.severity)).toEqual([
      'warning',
      'critical',
    ]);

    await harness.position({ mmsi: MMSI, ...east(900), ...anchored });
    expect(harness.alertsOf('ews')).toHaveLength(2);
    expect(harness.updates.map((update) => update.reason)).toEqual([
      'de-escalated',
    ]);

    // Under way again (predicted not at anchor): safe → the occurrence ends.
    await harness.position({
      mmsi: MMSI,
      ...east(900),
      navstatus: 0,
      predictedNavstatus: 0,
      sog: 6,
      cog: 90,
    });
    expect(harness.resolutions).toEqual([
      expect.objectContaining({
        reason: 'safe: not at anchor within the warning distance',
      }),
    ]);
    expect(harness.alertsOf('ews')).toHaveLength(2);
  });

  it('never rates a vessel that is not predicted at anchor (legacy rule)', async () => {
    const { harness, states } = setup();
    await harness.zone({ kind: 'pipeline', geometry: LINE });

    await harness.position({
      mmsi: MMSI,
      ...east(100),
      navstatus: 1,
      predictedNavstatus: 0,
      sog: 3,
      cog: 0,
    });

    expect(harness.alerts).toEqual([]);
    expect(states.last(MMSI)?.ews).toEqual(
      expect.objectContaining({
        ewsStatus: 3,
        pipelineDistanceM: expect.closeTo(100, 3) as unknown,
      }),
    );
  });

  it('reports the EWS part of every position, without a pipeline as safe', async () => {
    const { harness, states } = setup();
    await harness.position({ mmsi: MMSI, ...east(100), ...anchored });

    expect(states.reports).toEqual([
      expect.objectContaining({
        mmsi: MMSI,
        kinematics: expect.objectContaining({
          predictedNavstatus: 1,
        }) as unknown,
        ews: expect.objectContaining({
          ewsStatus: 3,
          pipelineDistanceM: null,
          nearestPipelineZoneId: null,
        }) as unknown,
      }),
    ]);
    expect(states.reports[0]?.collision).toBeUndefined();
    expect(harness.alerts).toEqual([]);
  });

  it('measures to the nearest active pipeline line only', async () => {
    const { harness, states } = setup();
    const near = await harness.zone({
      kind: 'pipeline',
      geometry: LINE,
      active: false,
    });
    const far = await harness.zone({
      kind: 'pipeline',
      geometry: {
        type: 'LineString',
        coordinates: [
          [112.72, -6.9],
          [112.72, -6.8],
        ],
      },
    });
    // A restricted polygon on top of the vessel is not a pipeline.
    await harness.zone({
      kind: 'restricted',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [112.69, -6.86],
            [112.71, -6.86],
            [112.71, -6.84],
            [112.69, -6.84],
            [112.69, -6.86],
          ],
        ],
      },
    });

    await harness.position({ mmsi: MMSI, ...east(200), ...anchored });

    expect(near.active).toBe(false);
    expect(states.last(MMSI)?.ews?.nearestPipelineZoneId).toBe(far.id);
    expect(harness.alertsOf('ews')).toEqual([]); // ≈ 2 km from the active pipeline
  });

  it('moves the alert when another pipeline becomes the nearest one', async () => {
    const { harness } = setup();
    const first = await harness.zone({ kind: 'pipeline', geometry: LINE });
    const second = await harness.zone({
      kind: 'pipeline',
      geometry: {
        type: 'LineString',
        coordinates: [
          [112.71, -6.9],
          [112.71, -6.8],
        ],
      },
    });

    await harness.position({ mmsi: MMSI, ...east(300), ...anchored });
    await harness.position({ mmsi: MMSI, ...east(1000), ...anchored }); // ≈ 100 m from the second

    expect(harness.alertsOf('ews').map((alert) => alert.zoneId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'another pipeline is nearer' }),
    ]);
  });

  it('resolves the open alerts of a removed or deactivated pipeline zone', async () => {
    const { harness } = setup();
    const zone = await harness.zone({ kind: 'pipeline', geometry: LINE });
    await harness.position({ mmsi: MMSI, ...east(300), ...anchored });
    await harness.position({ mmsi: MMSI + 1, ...east(1200), ...anchored });

    await harness.zone({
      ...zone,
      active: false,
      updatedAt: new Date('2026-01-02T00:00:00Z').toISOString(),
    });
    expect(harness.resolutions.map((resolution) => resolution.reason)).toEqual([
      'zone is no longer an active pipeline',
      'zone is no longer an active pipeline',
    ]);
  });

  it('honours EWS_DANGER_M / EWS_WARNING_M and refuses inconsistent thresholds', async () => {
    const { harness } = setup({ EWS_DANGER_M: '200', EWS_WARNING_M: '600' });
    await harness.zone({ kind: 'pipeline', geometry: LINE });
    await harness.position({ mmsi: MMSI, ...east(300), ...anchored });
    expect(harness.alertsOf('ews').map((alert) => alert.severity)).toEqual([
      'warning',
    ]);
    expect(harness.describe()).toEqual([
      expect.objectContaining({
        id: 'ews',
        enabled: true,
        config: { DANGER_M: 200, WARNING_M: 600 },
      }),
    ]);

    expect(() => setup({ EWS_DANGER_M: '2000' })).toThrow(
      ConfigValidationError,
    );
  });

  describe('org-owned pipeline zones (spec §8.5)', () => {
    const ORG_P = '0195f3c4-0000-7000-8000-0000000000a1';
    const ORG_Q = '0195f3c4-0000-7000-8000-0000000000a2';
    const OTHER = 525_005_224;

    it('apply only to the vessels of their organization', async () => {
      const { harness, states } = setup();
      const zone = await harness.zone({
        kind: 'pipeline',
        orgId: ORG_P,
        name: 'Private pipeline',
        geometry: LINE,
      });
      await harness.vessel({ mmsi: MMSI, orgId: ORG_P });
      await harness.vessel({ mmsi: OTHER, orgId: ORG_Q });

      await harness.position({ mmsi: OTHER, ...east(1000), ...anchored });
      expect(harness.alertsOf('ews')).toEqual([]);
      expect(states.last(OTHER)?.ews).toMatchObject({
        ewsStatus: 3,
        pipelineDistanceM: null,
        nearestPipelineZoneId: null,
        nearestPipelineOrgId: null,
      });

      await harness.position({ mmsi: MMSI, ...east(1000), ...anchored });
      const [alert] = harness.alertsOf('ews');
      expect(alert).toMatchObject({ mmsi: MMSI, zoneId: zone.id });
      expect(alert?.data).not.toHaveProperty('orgId');
      expect(states.last(MMSI)?.ews).toMatchObject({
        ewsStatus: 1,
        nearestPipelineZoneId: zone.id,
        nearestPipelineOrgId: ORG_P,
      });
    });

    it('never hide a global pipeline: another organization’s nearer zone is skipped', async () => {
      const { harness, states } = setup();
      const global = await harness.zone({ kind: 'pipeline', geometry: LINE });
      await harness.zone({
        kind: 'pipeline',
        orgId: ORG_P,
        geometry: {
          type: 'LineString',
          coordinates: [
            [112.705, -6.9],
            [112.705, -6.8],
          ],
        },
      });
      await harness.vessel({ mmsi: OTHER, orgId: ORG_Q });
      await harness.position({ mmsi: OTHER, ...east(1000), ...anchored });
      expect(states.last(OTHER)?.ews).toMatchObject({
        ewsStatus: 1,
        nearestPipelineZoneId: global.id,
        nearestPipelineOrgId: null,
      });
      expect(states.last(OTHER)?.ews?.pipelineDistanceM).toBeCloseTo(1000, 3);
    });

    it('resolve the open alert when the zone or the vessel changes organization', async () => {
      const { harness } = setup();
      const zone = await harness.zone({
        kind: 'pipeline',
        orgId: ORG_P,
        geometry: LINE,
      });
      await harness.vessel({ mmsi: MMSI, orgId: ORG_P });
      await harness.position({ mmsi: MMSI, ...east(1000), ...anchored });
      expect(harness.alertsOf('ews')).toHaveLength(1);

      harness.advance(60_000);
      await harness.zone({ ...zone, orgId: ORG_Q });
      expect(harness.resolutions.map((r) => r.reason)).toEqual([
        'pipeline zone is private to another organization',
      ]);

      harness.advance(60_000);
      await harness.zone({ ...zone, orgId: ORG_P });
      harness.advance(60_000);
      await harness.position({ mmsi: MMSI, ...east(900), ...anchored });
      expect(harness.services.alerts.openAlerts()).toHaveLength(1);
      harness.advance(60_000);
      await harness.vessel({ mmsi: MMSI, orgId: ORG_Q });
      expect(harness.services.alerts.openAlerts()).toEqual([]);
      expect(harness.resolutions.at(-1)?.reason).toBe(
        'pipeline zone is private to another organization',
      );
    });
  });

  it('reports every signal with its event time to the sightings (last_seen_at)', async () => {
    const { harness, sightings } = setup();
    const zone = await harness.zone({ kind: 'pipeline', geometry: LINE });
    const t0 = new Date('2026-03-01T00:00:00.000Z');
    await harness.position({
      mmsi: MMSI,
      ...east(1000),
      ...anchored,
      time: t0,
    });
    await harness.position({
      mmsi: MMSI,
      ...east(1010),
      ...anchored,
      time: new Date(t0.getTime() + 180_000),
    });
    expect(sightings.records).toEqual([
      { dedupKey: `ews:${MMSI}:${zone.id}`, seenAt: t0, outcome: 'raised' },
      {
        dedupKey: `ews:${MMSI}:${zone.id}`,
        seenAt: new Date(t0.getTime() + 180_000),
        outcome: 'unchanged',
      },
    ]);
  });
});
