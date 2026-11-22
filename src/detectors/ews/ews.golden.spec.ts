import { readFileSync } from 'node:fs';

import {
  DetectorTestHarness,
  makeTestZone,
  ZoneIndex,
} from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { assessEws } from '../../domain/ews.js';
import { RecordingStateSink } from '../__testing__/fakes.js';
import { EwsDetector, nearestPipeline } from './ews.detector.js';

/**
 * Golden cases produced ONCE by running the legacy `checkShipStatus`
 * (be-legacy/src/utils/calculate-ews.ts) with Turf.js 7.2.0 against the
 * legacy `data/pipeline.json` (scripts/golden/generate-ews-golden.mjs).
 */
const GoldenSchema = z.object({
  pipeline: z.object({
    type: z.literal('LineString'),
    coordinates: z.array(z.tuple([z.number(), z.number()])),
  }),
  cases: z
    .array(
      z.object({
        label: z.string(),
        lat: z.number(),
        lon: z.number(),
        distanceM: z.number(),
        statusAnchored: z.union([z.literal(0), z.literal(1), z.literal(3)]),
        statusNotAnchored: z.literal(3),
      }),
    )
    .min(20),
});

const golden = GoldenSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('./__fixtures__/legacy-ews-golden.json', import.meta.url),
      'utf8',
    ),
  ),
);

const pipelineZone = makeTestZone({
  kind: 'pipeline',
  code: 'mvp-pipeline',
  name: 'Subsea pipeline (MVP dataset)',
  bufferM: 1750,
  geometry: golden.pipeline,
});

describe('EWS legacy parity (golden, ews.pipeline_distance_status)', () => {
  const index = new ZoneIndex({ distanceModel: 'sphere' });
  index.upsert(pipelineZone);

  it.each(golden.cases)(
    '$label: distance and status equal checkShipStatus',
    (testCase) => {
      const nearest = nearestPipeline(index, testCase, null);
      expect(nearest?.zoneId).toBe(pipelineZone.id);
      // The SDK's sphere model reproduces @turf/nearest-point-on-line 7.2 + @turf/distance.
      expect(
        Math.abs((nearest?.distanceM ?? Number.NaN) - testCase.distanceM),
      ).toBeLessThan(1e-5);
      expect(assessEws(nearest, 1).ewsStatus).toBe(testCase.statusAnchored);
      expect(assessEws(nearest, 0).ewsStatus).toBe(testCase.statusNotAnchored);
    },
  );

  it('covers both thresholds from both sides within 0.2 m', () => {
    const near = (threshold: number) =>
      golden.cases.filter((c) => Math.abs(c.distanceM - threshold) < 0.2);
    expect(
      near(500)
        .map((c) => c.statusAnchored)
        .sort(),
    ).toEqual([0, 0, 1, 1]);
    expect(
      near(1750)
        .map((c) => c.statusAnchored)
        .sort(),
    ).toEqual([1, 1, 3, 3]);
  });

  it('raises the alert severity of the legacy status through the detector', async () => {
    const harness = DetectorTestHarness.create({
      detectors: [new EwsDetector(new RecordingStateSink())],
      distanceModel: 'sphere',
    });
    await harness.zone(pipelineZone);
    let mmsi = 525_100_000;
    const expected: string[] = [];
    for (const c of golden.cases) {
      mmsi += 1;
      await harness.position({
        mmsi,
        lat: c.lat,
        lon: c.lon,
        predictedNavstatus: 1,
        navstatus: 1,
      });
      if (c.statusAnchored === 0) expected.push(`${mmsi}:critical`);
      if (c.statusAnchored === 1) expected.push(`${mmsi}:warning`);
    }
    expect(
      harness.alertsOf('ews').map((alert) => `${alert.mmsi}:${alert.severity}`),
    ).toEqual(expected);
    expect(harness.logs.filter((line) => line.startsWith('error'))).toEqual([]);
  });
});
