import { describe, expect, it } from 'vitest';

import { assessEws, ewsDedupKey, isLineGeometry } from './ews.js';

describe('assessEws (ews.pipeline_distance_status)', () => {
  const zoneId = '0195f3c4-0000-7000-8000-000000000001';

  it('rates only vessels predicted at anchor: < 500 m danger, < 1 750 m warning', () => {
    expect(assessEws({ zoneId, distanceM: 499.99 }, 1)).toEqual({
      ewsStatus: 0,
      pipelineDistanceM: 499.99,
      nearestPipelineZoneId: zoneId,
      severity: 'critical',
    });
    expect(assessEws({ zoneId, distanceM: 500 }, 1)).toMatchObject({
      ewsStatus: 1,
      severity: 'warning',
    });
    expect(assessEws({ zoneId, distanceM: 1749.99 }, 1)).toMatchObject({
      ewsStatus: 1,
    });
    expect(assessEws({ zoneId, distanceM: 1750 }, 1)).toMatchObject({
      ewsStatus: 3,
      severity: null,
    });
    expect(assessEws({ zoneId, distanceM: 10 }, 0)).toMatchObject({
      ewsStatus: 3,
      severity: null,
    });
  });

  it('is safe without any active pipeline', () => {
    expect(assessEws(undefined, 1)).toEqual({
      ewsStatus: 3,
      pipelineDistanceM: null,
      nearestPipelineZoneId: null,
      severity: null,
    });
  });

  it('applies configured thresholds', () => {
    expect(
      assessEws({ zoneId, distanceM: 250 }, 1, { dangerM: 200, warningM: 600 }),
    ).toMatchObject({
      ewsStatus: 1,
    });
  });
});

describe('EWS helpers', () => {
  it('builds the alert key ews:<mmsi>:<zoneId>', () => {
    expect(ewsDedupKey(525005223, 'z')).toBe('ews:525005223:z');
  });

  it('accepts line geometries only', () => {
    expect(
      isLineGeometry({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toBe(true);
    expect(
      isLineGeometry({
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      }),
    ).toBe(true);
    expect(isLineGeometry({ type: 'Point', coordinates: [0, 0] })).toBe(false);
  });
});
