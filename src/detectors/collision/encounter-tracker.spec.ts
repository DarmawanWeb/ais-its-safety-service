import { describe, expect, it } from 'vitest';

import {
  EncounterTracker,
  type PairMeasurement,
  sameCollisionCategory,
} from './encounter-tracker.js';

const positions = {
  a: {
    mmsi: 1,
    time: '2026-01-01T00:00:00.000Z',
    lat: 0,
    lon: 0,
    sog: 10,
    cog: 0,
  },
  b: {
    mmsi: 2,
    time: '2026-01-01T00:00:00.000Z',
    lat: 0,
    lon: 0.01,
    sog: 10,
    cog: 270,
  },
};
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
const measure = (
  seconds: number,
  cpaNm: number,
  tcpaMin: number | null = 5,
): PairMeasurement => ({
  cpaNm,
  tcpaMin,
  rangeNm: 1,
  at: at(seconds),
  positions,
});

describe('EncounterTracker', () => {
  let ids = 0;
  const tracker = () => new EncounterTracker(() => `encounter-${++ids}`);

  it('opens an encounter above none and keeps its id until it returns to none', () => {
    const encounters = tracker();
    expect(
      encounters.apply('k', 1, 2, 'none', measure(0, 2), 30_000),
    ).toBeUndefined();

    const opened = encounters.apply(
      'k',
      1,
      2,
      'medium',
      measure(10, 0.4),
      30_000,
    );
    expect(opened).toMatchObject({
      before: 'none',
      after: 'medium',
      sample: true,
    });
    const escalated = encounters.apply(
      'k',
      1,
      2,
      'high',
      measure(20, 0.2),
      30_000,
    );
    expect(escalated).toMatchObject({
      before: 'medium',
      after: 'high',
      sample: true,
    });
    expect(escalated?.encounterId).toBe(opened?.encounterId);

    const ended = encounters.apply(
      'k',
      1,
      2,
      'none',
      measure(30, 0.2, -1),
      30_000,
    );
    expect(ended).toMatchObject({
      before: 'high',
      after: 'none',
      sample: true,
    });
    expect(encounters.has('k')).toBe(false);
    expect(encounters.keysOf(1)).toEqual([]);
  });

  it('samples an unchanged band at most every interval', () => {
    const encounters = tracker();
    encounters.apply('k', 1, 2, 'low', measure(0, 0.8), 30_000);
    expect(
      encounters.apply('k', 1, 2, 'low', measure(10, 0.8), 30_000)?.sample,
    ).toBe(false);
    expect(
      encounters.apply('k', 1, 2, 'low', measure(29, 0.8), 30_000)?.sample,
    ).toBe(false);
    expect(
      encounters.apply('k', 1, 2, 'low', measure(30, 0.8), 30_000)?.sample,
    ).toBe(true);
  });

  it('ignores evaluations older than the tracked one (out-of-order vessels)', () => {
    const encounters = tracker();
    encounters.apply('k', 1, 2, 'high', measure(20, 0.1), 30_000);
    expect(
      encounters.apply('k', 1, 2, 'none', measure(10, 0.9), 30_000),
    ).toBeUndefined();
    expect(encounters.get('k')?.risk).toBe('high');
  });

  it('summarizes a vessel by its highest band, then the smallest CPA', () => {
    const encounters = tracker();
    encounters.apply('a', 1, 2, 'medium', measure(0, 0.45), 30_000);
    encounters.apply('b', 1, 3, 'medium', measure(0, 0.3), 30_000);
    encounters.apply('c', 1, 4, 'low', measure(0, 0.1), 30_000);
    expect(encounters.summaryOf(1)).toEqual({
      risk: 'medium',
      closest: { otherMmsi: 3, cpaNm: 0.3, tcpaMin: 5 },
    });
    expect(encounters.summaryOf(4).closest?.otherMmsi).toBe(1);
    expect(encounters.summaryOf(99)).toEqual({ risk: 'none', closest: null });
    expect(encounters.counts()).toEqual({ low: 1, medium: 2, high: 0 });
  });

  it('closes pairs without an evaluation and finds stale ones', () => {
    const encounters = tracker();
    encounters.apply('k', 1, 2, 'medium', measure(0, 0.4), 30_000);
    expect(encounters.staleBefore(at(0))).toEqual([]);
    expect(encounters.staleBefore(at(1)).map((e) => e.key)).toEqual(['k']);
    expect(encounters.close('k')).toMatchObject({
      after: 'none',
      measurement: undefined,
      sample: false,
    });
    expect(encounters.close('k')).toBeUndefined();
  });

  it('compares state categories by band and other vessel only', () => {
    const one = {
      risk: 'medium' as const,
      closest: { otherMmsi: 2, cpaNm: 0.4, tcpaMin: 5 },
    };
    expect(
      sameCollisionCategory(one, {
        ...one,
        closest: { ...one.closest, cpaNm: 0.3 },
      }),
    ).toBe(true);
    expect(
      sameCollisionCategory(one, {
        ...one,
        closest: { ...one.closest, otherMmsi: 3 },
      }),
    ).toBe(false);
  });
});
