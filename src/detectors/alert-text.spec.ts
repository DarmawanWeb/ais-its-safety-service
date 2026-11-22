import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  localizable,
  MESSAGE_KEYS,
  metresOfNm,
  rounded,
  supersededText,
} from './alert-text.js';

const KEYS = Object.values(MESSAGE_KEYS);

describe('localizable texts (messageKey / messageParams)', () => {
  it('uses stable dotted keys <domain>.<detector>.<situation>, lowercase with underscores', () => {
    for (const key of KEYS)
      expect(key).toMatch(/^safety\.(ews|collision)\.[a-z][a-z0-9_]*$/);
    expect(new Set(KEYS).size).toBe(KEYS.length);
  });

  it('documents every key in the README table (the web translates from it)', () => {
    const readme = readFileSync(
      new URL('../../README.md', import.meta.url),
      'utf8',
    );
    for (const key of KEYS) expect(readme).toContain(`| \`${key}\``);
  });

  it('builds the data fields and the texts of superseded events', () => {
    expect(localizable(MESSAGE_KEYS.ewsResolvedSafe)).toEqual({
      messageKey: 'safety.ews.resolved_safe',
      messageParams: {},
    });
    expect(supersededText('ews', 'escalated')).toEqual({
      messageKey: 'safety.ews.escalated',
      messageParams: {},
    });
    expect(supersededText('collision', 'superseded')?.messageKey).toBe(
      'safety.collision.superseded',
    );
    expect(supersededText('dark', 'escalated')).toBeUndefined();
  });

  it('rounds parameter values like the English text, without a negative zero', () => {
    expect(rounded(0.084_9, 2)).toBe(0.08);
    expect(rounded(9.96, 1)).toBe(10);
    expect(Object.is(rounded(-0.001, 2), 0)).toBe(true);
  });

  it('gives distances in whole metres (the platform unit of distance params)', () => {
    expect(metresOfNm(0.084_9)).toBe(157);
    expect(metresOfNm(2.83)).toBe(5241);
    expect(Object.is(metresOfNm(-0.000_1), 0)).toBe(true);
  });
});
