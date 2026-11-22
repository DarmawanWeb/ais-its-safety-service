import { describe, expect, it } from 'vitest';

import {
  computeCpaTcpa,
  deadReckon,
  isCogAvailable,
  isSogAvailable,
  type MotionState,
  predictedCpaPositions,
  relativePositionNm,
  velocityKn,
} from './cpa.js';

/** A vessel at `x` nm east and `y` nm north of 0°N 0°E (at the equator 1 nm = 1/60°). */
const at = (
  x: number,
  y: number,
  sogKn: number,
  cogDeg: number,
): MotionState => ({
  lat: y / 60,
  lon: x / 60,
  sogKn,
  cogDeg,
});

/**
 * Hand-computed cases of CPA = |Δx Δv_y − Δy Δv_x| / |Δv| and
 * TCPA = −60 (Δp · Δv) / |Δv|² (docs/METHODOLOGY.md §6.1). Own vessel i is
 * at the origin; the expected values are worked out in the comments.
 */
describe('computeCpaTcpa (collision.cpa_tcpa)', () => {
  it('head-on: 2 nm apart, 10 kn each → collision course in 6 min', () => {
    // Δp = (0, 2), Δv = (0, −10) − (0, 10) = (0, −20); TCPA = −60·(−40)/400 = 6; CPA = 0.
    const result = computeCpaTcpa(at(0, 0, 10, 0), at(0, 2, 10, 180));
    expect(result.cpaNm).toBeCloseTo(0, 9);
    expect(result.tcpaMin).toBeCloseTo(6, 9);
    expect(result.rangeNm).toBeCloseTo(2, 9);
    expect(result.relativeSpeedKn).toBeCloseTo(20, 9);
  });

  it('crossing at right angles on a collision course', () => {
    // Target 1 nm east, 1 nm north, heading west at 10 kn; own heading north at 10 kn.
    // Δp = (1, 1), Δv = (−10, −10); TCPA = −60·(−20)/200 = 6; CPA = |1·(−10) − 1·(−10)|/√200 = 0.
    const result = computeCpaTcpa(at(0, 0, 10, 0), at(1, 1, 10, 270));
    expect(result.cpaNm).toBeCloseTo(0, 9);
    expect(result.tcpaMin).toBeCloseTo(6, 9);
    expect(result.rangeNm).toBeCloseTo(Math.SQRT2, 9);
  });

  it('crossing that passes ahead', () => {
    // Δp = (1, 1.5), Δv = (−10, −10): Δp·Δv = −25 → TCPA = 60·25/200 = 7.5;
    // CPA = |1·(−10) − 1.5·(−10)|/√200 = 5/√200 = 0.353553…
    const result = computeCpaTcpa(at(0, 0, 10, 0), at(1, 1.5, 10, 270));
    expect(result.cpaNm).toBeCloseTo(5 / Math.sqrt(200), 9);
    expect(result.tcpaMin).toBeCloseTo(7.5, 9);
  });

  it('overtaking a slower vessel ahead with 0.1 nm lateral offset', () => {
    // Δp = (0.1, 1), Δv = (0, 8 − 12) = (0, −4); TCPA = −60·(−4)/16 = 15; CPA = |0.1·(−4)|/4 = 0.1.
    const result = computeCpaTcpa(at(0, 0, 12, 0), at(0.1, 1, 8, 0));
    expect(result.cpaNm).toBeCloseTo(0.1, 9);
    expect(result.tcpaMin).toBeCloseTo(15, 9);
  });

  it('parallel courses at the same speed: no relative motion, TCPA undefined', () => {
    const result = computeCpaTcpa(at(0, 0, 10, 45), at(0.3, 0, 10, 45));
    expect(result.tcpaMin).toBeNull();
    expect(result.cpaNm).toBeCloseTo(0.3, 9);
    expect(result.rangeNm).toBeCloseTo(0.3, 9);
    expect(result.relativeSpeedKn).toBeCloseTo(0, 9);
  });

  it('diverging: the closest point lies in the past (TCPA < 0)', () => {
    // Target 1 nm astern heading south: Δp = (0, −1), Δv = (0, −20); TCPA = −60·20/400 = −3.
    const result = computeCpaTcpa(at(0, 0, 10, 0), at(0, -1, 10, 180));
    expect(result.tcpaMin).toBeCloseTo(-3, 9);
    expect(result.cpaNm).toBeCloseTo(0, 9);
  });

  it('stationary target ahead and slightly to port', () => {
    // Own east at 6 kn, target still at (2, 0.2): Δv = (−6, 0); TCPA = −60·(−12)/36 = 20;
    // CPA = |2·0 − 0.2·(−6)|/6 = 0.2.
    const result = computeCpaTcpa(at(0, 0, 6, 90), at(2, 0.2, 0, 0));
    expect(result.tcpaMin).toBeCloseTo(20, 9);
    expect(result.cpaNm).toBeCloseTo(0.2, 9);
    expect(result.rangeNm).toBeCloseTo(Math.hypot(2, 0.2), 9);
  });

  it('is symmetric in CPA and TCPA', () => {
    const own = at(0, 0, 11, 30);
    const target = at(1.2, 2.5, 7, 200);
    const forward = computeCpaTcpa(own, target);
    const backward = computeCpaTcpa(target, own);
    expect(backward.cpaNm).toBeCloseTo(forward.cpaNm, 3);
    expect(backward.tcpaMin ?? 0).toBeCloseTo(forward.tcpaMin ?? 0, 3);
  });
});

describe('relativePositionNm', () => {
  it('scales longitude by cos(latitude) and folds across the antimeridian', () => {
    const own = { lat: 60, lon: 179.99 };
    const offset = relativePositionNm(own, { lat: 60, lon: -179.99 });
    // 0.02° of longitude at 60°N = 0.02 · 60 · 0.5 nm = 0.6 nm east.
    expect(offset.x).toBeCloseTo(0.6, 6);
    expect(offset.y).toBeCloseTo(0, 9);
  });
});

describe('velocityKn', () => {
  it('points along the course (north = 0°, east = 90°)', () => {
    expect(velocityKn(10, 90).x).toBeCloseTo(10, 9);
    expect(velocityKn(10, 90).y).toBeCloseTo(0, 9);
    expect(velocityKn(10, 180).y).toBeCloseTo(-10, 9);
  });
});

describe('deadReckon', () => {
  it('moves along the course on the local plane, back in time for negative minutes', () => {
    const start = at(0, 0, 12, 0);
    expect(deadReckon(start, 30).lat).toBeCloseTo(6 / 60, 9); // 6 nm north
    expect(deadReckon(start, -30).lat).toBeCloseTo(-6 / 60, 9);
    expect(deadReckon(at(0, 0, 6, 90), 60).lon).toBeCloseTo(6 / 60, 9);
  });
});

describe('AIS availability', () => {
  it('treats SOG 102.3 and COG 360 as not available', () => {
    expect(isSogAvailable(102.3)).toBe(false);
    expect(isSogAvailable(12.5)).toBe(true);
    expect(isCogAvailable(360)).toBe(false);
    expect(isCogAvailable(359.9)).toBe(true);
    expect(isCogAvailable(Number.NaN)).toBe(false);
  });
});

describe('predictedCpaPositions (collision.cpa_tcpa)', () => {
  const T = new Date('2026-01-01T00:00:00.000Z');
  const timed = (state: MotionState, secondsAfterT = 0) => ({
    ...state,
    time: new Date(T.getTime() + secondsAfterT * 1000),
  });

  it('meets at the crossing point of a collision course', () => {
    // A northwards from (0, 0), B westwards from (2, 2), 12 kn each: both at (0, 2) after 10 min.
    const a = timed(at(0, 0, 12, 0));
    const b = timed(at(2, 2, 12, 270));
    const { tcpaMin } = computeCpaTcpa(a, b);
    const positions = predictedCpaPositions(a, b, T, tcpaMin);
    expect(tcpaMin).toBeCloseTo(10, 9);
    expect(positions?.a.lat).toBeCloseTo(2 / 60, 6);
    expect(positions?.a.lon).toBeCloseTo(0, 6);
    expect(positions?.b.lat).toBeCloseTo(2 / 60, 6);
    expect(positions?.b.lon).toBeCloseTo(0, 6);
  });

  it('dead-reckons each report from its own time to the CPA instant', () => {
    // B reported 30 s before the evaluation: it moves 30 s longer.
    const a = timed(at(0, 0, 12, 0));
    const b = timed(at(2.1, 2, 12, 270), -30);
    const aligned = { ...deadReckon(b, 0.5), sogKn: 12, cogDeg: 270 };
    const { cpaNm, tcpaMin } = computeCpaTcpa(a, aligned);
    const positions = predictedCpaPositions(a, b, T, tcpaMin);
    expect(positions).toBeDefined();
    // The predicted points are the CPA apart (equator plane: 1 nm = 1/60°).
    const dx = ((positions?.b.lon ?? 0) - (positions?.a.lon ?? 0)) * 60;
    const dy = ((positions?.b.lat ?? 0) - (positions?.a.lat ?? 0)) * 60;
    expect(Math.hypot(dx, dy)).toBeCloseTo(cpaNm, 5);
  });

  it('has none without relative motion, for a past CPA or without SOG/COG', () => {
    const a = timed(at(0, 0, 10, 0));
    const b = timed(at(1, 0, 10, 0));
    expect(predictedCpaPositions(a, b, T, null)).toBeUndefined();
    expect(predictedCpaPositions(a, b, T, -2)).toBeUndefined();
    expect(
      predictedCpaPositions(a, { ...b, sogKn: 102.3 }, T, 5),
    ).toBeUndefined();
    expect(
      predictedCpaPositions(a, { ...b, cogDeg: 360 }, T, 5),
    ).toBeUndefined();
  });
});
