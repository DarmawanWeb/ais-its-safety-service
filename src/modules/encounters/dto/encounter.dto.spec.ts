import { describe, expect, it } from 'vitest';

import { activeEncounterWindowMs, type EncounterRecord } from '../encounter.js';
import { EncounterDto } from './encounter.dto.js';

const T = new Date('2026-01-01T00:10:00.000Z');
const A = 525_000_001;
const B = 525_000_002;

/** A northwards and B westwards at 12 kn, both reaching (0, 2) nm (equator plane) after `tcpaMin`. */
function sample(tcpaMin: number | null) {
  return {
    time: T,
    cpaNm: 0,
    tcpaMin,
    rangeNm: 2.83,
    risk: 'medium' as const,
    positions: {
      a: { mmsi: A, time: T.toISOString(), lat: 0, lon: 0, sog: 12, cog: 0 },
      b: {
        mmsi: B,
        time: T.toISOString(),
        lat: 2 / 60,
        lon: 2 / 60,
        sog: 12,
        cog: 270,
      },
    },
  };
}

function record(overrides: Partial<EncounterRecord> = {}): EncounterRecord {
  return {
    encounterId: '0195f3c4-0000-7000-8000-0000000000e1',
    mmsiA: A,
    mmsiB: B,
    vesselA: {
      id: '0195f3c4-0000-7000-8000-0000000000a1',
      name: 'KM Alpha',
      typeCode: 'tanker',
    },
    vesselB: null,
    startedAt: T,
    lastSampleAt: T,
    peakRisk: 'high',
    minCpaNm: 0.084_9,
    history: [sample(10), sample(-1), sample(null)],
    ...overrides,
  };
}

describe('EncounterDto', () => {
  it('carries the fleet identities and the localizable text of the encounter', () => {
    const dto = new EncounterDto(record());
    expect(dto.vesselA).toEqual({
      id: '0195f3c4-0000-7000-8000-0000000000a1',
      name: 'KM Alpha',
      typeCode: 'tanker',
    });
    expect(dto.vesselB).toBeNull();
    expect(dto.messageKey).toBe('safety.collision.encounter');
    expect(dto.messageParams).toEqual({
      vesselA: `KM Alpha (MMSI ${A})`,
      mmsiA: A,
      vesselB: `MMSI ${B}`,
      mmsiB: B,
      peakRisk: 'high',
      // Whole metres (cross-service convention) and the nm of the English text.
      minCpaM: 157,
      minCpaNm: 0.08,
    });
  });

  it('predicts both positions at the closest point of approach, none for a past or undefined CPA', () => {
    const [ahead, past, still] = new EncounterDto(record()).history;
    expect(ahead?.cpaPositions?.a.lat).toBeCloseTo(2 / 60, 6);
    expect(ahead?.cpaPositions?.a.lon).toBeCloseTo(0, 6);
    expect(ahead?.cpaPositions?.b.lat).toBeCloseTo(2 / 60, 6);
    expect(ahead?.cpaPositions?.b.lon).toBeCloseTo(0, 6);
    expect(past?.cpaPositions).toBeNull();
    expect(still?.cpaPositions).toBeNull();
  });
});

describe('activeEncounterWindowMs', () => {
  it('covers the sample interval, the staleness window and one housekeeping tick', () => {
    expect(
      activeEncounterWindowMs({ MAX_AGE_S: 120, SAMPLE_INTERVAL_S: 30 }),
    ).toBe(180_000);
    expect(
      activeEncounterWindowMs({ MAX_AGE_S: 60, SAMPLE_INTERVAL_S: 0 }),
    ).toBe(90_000);
  });
});
