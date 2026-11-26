import type { Principal } from '@darmawanweb/ais-its-contracts/auth';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';

import { ListVesselStatesQuery } from './dto/list-vessel-states.query.js';
import { SafetyStatsDto } from './dto/safety-stats.dto.js';
import { SafetyStatsQuery } from './dto/safety-stats.query.js';
import type { AtRiskCounts } from './vessel-state.js';
import type { VesselStatesRepository } from './vessel-states.repository.js';
import { VesselStatesService } from './vessel-states.service.js';

const NOW = new Date('2026-11-23T08:00:00.000Z');
const DAY_MS = 24 * 60 * 60_000;
const COUNTS: AtRiskCounts = {
  ews: { danger: 2, warning: 5 },
  collision: { high: 1, medium: 3 },
};

const viewer: Principal = {
  kind: 'user',
  id: '0195f3c4-0000-7000-8000-000000000011',
  sessionId: '0195f3c4-0000-7000-8000-000000000012',
  orgId: '0195f3c4-0000-7000-8000-000000000013',
  roles: ['viewer'],
  email: 'viewer@example.test',
  name: 'Viewer',
};

/** The service on a fake repository. */
function setup() {
  const list = vi.fn<VesselStatesRepository['list']>(() => Promise.resolve([]));
  const countAtRisk = vi.fn<VesselStatesRepository['countAtRisk']>(() =>
    Promise.resolve(COUNTS),
  );
  const service = new VesselStatesService({
    list,
    countAtRisk,
  } as unknown as VesselStatesRepository);
  return { service, list, countAtRisk };
}

describe('VesselStatesService.stats (GET /safety/stats)', () => {
  it('counts the vessels with a position in the last 24 h by default and stamps the counts', async () => {
    const { service, countAtRisk } = setup();
    const stats = await service.stats(
      plainToInstance(SafetyStatsQuery, {}),
      NOW,
    );
    expect(countAtRisk).toHaveBeenCalledWith({
      bbox: undefined,
      since: new Date(NOW.getTime() - DAY_MS),
    });
    expect(stats).toEqual({
      ...COUNTS,
      since: new Date(NOW.getTime() - DAY_MS),
      at: NOW,
    });
  });

  it('counts the window the list reads for the same bbox and since', async () => {
    const { service, list, countAtRisk } = setup();
    const window = {
      bbox: '112.5,-7.3,113,-6.8',
      since: '2026-11-23T07:30:00Z',
    };
    // As the validation pipe builds them from the query string.
    await service.stats(plainToInstance(SafetyStatsQuery, window), NOW);
    await service.list(
      plainToInstance(ListVesselStatesQuery, window),
      viewer,
      NOW,
    );
    const counted = countAtRisk.mock.calls[0]?.[0];
    expect(counted).toEqual({
      bbox: [112.5, -7.3, 113, -6.8],
      since: new Date('2026-11-23T07:30:00.000Z'),
    });
    expect(list.mock.calls[0]?.[0]).toMatchObject({ ...counted });
  });
});

describe('SafetyStatsDto', () => {
  it('names the methodology id of each group and serializes the times', () => {
    const dto = new SafetyStatsDto({
      ...COUNTS,
      since: new Date(NOW.getTime() - DAY_MS),
      at: NOW,
    });
    expect(JSON.parse(JSON.stringify(dto))).toEqual({
      ews: { danger: 2, warning: 5, methodId: 'ews.pipeline_distance_status' },
      collision: { high: 1, medium: 3, methodId: 'collision.cpa_tcpa' },
      since: '2026-11-22T08:00:00.000Z',
      at: '2026-11-23T08:00:00.000Z',
    });
  });
});

describe('since (GET /safety/vessels and GET /safety/stats)', () => {
  /** The constraints `since` fails in both queries (as the validation pipe builds them). */
  const failures = async (since: string) =>
    Promise.all(
      [ListVesselStatesQuery, SafetyStatsQuery].map(async (type) => {
        const errors = await validate(plainToInstance(type, { since }));
        return Object.keys(
          errors.find((error) => error.property === 'since')?.constraints ?? {},
        );
      }),
    );

  it('refuses ISO-8601 forms that Date cannot read (they used to fail with 500)', async () => {
    for (const since of [
      '2026-11-23T10', // hour only
      '2026-W48', // week date
      '20261122', // basic format
      '2026-327', // ordinal date
      '2026-11-23T10:00:00,5Z', // comma fraction
      '2026-11-23T1000', // no colon
      '-2026-11-22T00:00:00Z', // signed year
      '2026-11-23T10:00:00+07', // hour-only offset
      'yesterday',
    ])
      expect(await failures(since), since).toEqual([
        ['isIso8601'],
        ['isIso8601'],
      ]);
  });

  it('accepts the date-times it accepted before', async () => {
    for (const since of [
      '2026-11-23T07:30:00Z',
      '2026-11-23T07:30:00.123Z',
      '2026-11-23T07:30:00+07:00',
      '2026-11-23T07:30:00.5+0700',
      '2026-11-23T07:30',
      '2026-11-23',
    ])
      expect(await failures(since), since).toEqual([[], []]);
  });
});
