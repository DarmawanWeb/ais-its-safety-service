import { describe, expect, it } from 'vitest';

import {
  applyRiskHysteresis,
  assessCollisionRisk,
  classifyCollisionRisk,
  collisionDedupKey,
  collisionExclusion,
} from './collision-risk.js';

const moving = { navstatus: 0, predictedNavstatus: 0, sog: 12, cog: 45 };

describe('classifyCollisionRisk (spec §13.7 default bands)', () => {
  it.each([
    [0.2, 5, 'high'],
    [0.2, 6, 'medium'], // TCPA 6 is outside the high band (TCPA < 6)
    [0.3, 5, 'medium'],
    [0.49, 11.9, 'medium'],
    [0.5, 5, 'low'], // CPA 0.5 is outside the medium band (CPA < 0.5)
    [0.9, 19, 'low'],
    [1, 5, 'none'],
    [0.2, 20, 'none'],
    [0, 0, 'high'], // TCPA 0 is included (0 ≤ TCPA)
  ] as const)('CPA %s nm, TCPA %s min → %s', (cpaNm, tcpaMin, risk) => {
    expect(classifyCollisionRisk({ cpaNm, tcpaMin })).toBe(risk);
  });

  it('never rates diverging pairs or pairs without relative motion', () => {
    expect(classifyCollisionRisk({ cpaNm: 0.1, tcpaMin: -0.5 })).toBe('none');
    expect(classifyCollisionRisk({ cpaNm: 0.1, tcpaMin: null })).toBe('none');
  });

  it('uses configured bands', () => {
    const bands = {
      high: { cpaNm: 0.1, tcpaMin: 3 },
      medium: { cpaNm: 0.2, tcpaMin: 6 },
      low: { cpaNm: 0.3, tcpaMin: 9 },
    };
    expect(classifyCollisionRisk({ cpaNm: 0.15, tcpaMin: 2 }, bands)).toBe(
      'medium',
    );
  });
});

describe('applyRiskHysteresis (20 % widening)', () => {
  it('rises at once', () => {
    expect(applyRiskHysteresis('high', 'low', { cpaNm: 0.1, tcpaMin: 3 })).toBe(
      'high',
    );
    expect(
      applyRiskHysteresis('medium', undefined, { cpaNm: 0.4, tcpaMin: 3 }),
    ).toBe('medium');
  });

  it('keeps the previous band while within its widened limits', () => {
    // high widened: CPA < 0.3, TCPA < 7.2
    expect(assessCollisionRisk({ cpaNm: 0.28, tcpaMin: 4 }, 'high')).toBe(
      'high',
    );
    expect(assessCollisionRisk({ cpaNm: 0.2, tcpaMin: 7 }, 'high')).toBe(
      'high',
    );
    // medium widened: CPA < 0.6, TCPA < 14.4
    expect(assessCollisionRisk({ cpaNm: 0.55, tcpaMin: 10 }, 'medium')).toBe(
      'medium',
    );
  });

  it('falls to the highest band whose widened limits still hold', () => {
    // Outside widened high (CPA 0.35 ≥ 0.3) but inside widened medium.
    expect(assessCollisionRisk({ cpaNm: 0.35, tcpaMin: 4 }, 'high')).toBe(
      'medium',
    );
    // Outside widened medium; raw low.
    expect(assessCollisionRisk({ cpaNm: 0.65, tcpaMin: 4 }, 'medium')).toBe(
      'low',
    );
    // Outside every widened band.
    expect(assessCollisionRisk({ cpaNm: 1.3, tcpaMin: 4 }, 'low')).toBe('none');
  });

  it('never delays the end of an encounter (diverging)', () => {
    expect(assessCollisionRisk({ cpaNm: 0.1, tcpaMin: -0.1 }, 'high')).toBe(
      'none',
    );
    expect(assessCollisionRisk({ cpaNm: 0.1, tcpaMin: null }, 'medium')).toBe(
      'none',
    );
  });
});

describe('collisionExclusion', () => {
  it('includes a vessel under way above the minimum speed', () => {
    expect(collisionExclusion(moving, 0.5)).toBeNull();
  });

  it.each([
    [{ ...moving, predictedNavstatus: 1 }, 'predicted_at_anchor'],
    [{ ...moving, navstatus: 1 }, 'stationary_navstatus'], // at anchor
    [{ ...moving, navstatus: 5 }, 'stationary_navstatus'], // moored
    [{ ...moving, navstatus: 6 }, 'stationary_navstatus'], // aground
    [{ ...moving, sog: 102.3 }, 'sog_unavailable'],
    [{ ...moving, cog: 360 }, 'cog_unavailable'],
    [{ ...moving, sog: 0.4 }, 'slow'],
  ] as const)('%o → %s', (vessel, reason) => {
    expect(collisionExclusion(vessel, 0.5)).toBe(reason);
  });
});

describe('collisionDedupKey', () => {
  it('orders the pair', () => {
    expect(collisionDedupKey(525005224, 525005223)).toBe(
      'collision:525005223:525005224',
    );
    expect(collisionDedupKey(525005223, 525005224)).toBe(
      'collision:525005223:525005224',
    );
  });
});
