import { encodeCursor } from '@darmawanweb/ais-its-contracts/api';
import type { Principal } from '@darmawanweb/ais-its-contracts/auth';
import { describe, expect, it, vi } from 'vitest';

import type { ListEncountersQuery } from './dto/list-encounters.query.js';
import type { EncounterFilter } from './encounter.js';
import type { EncountersRepository } from './encounters.repository.js';
import { EncountersService } from './encounters.service.js';

const NOW = new Date('2026-11-22T12:00:00.000Z');
const WINDOW_MS = 180_000; // COLLISION_* defaults

const authority: Principal = {
  kind: 'user',
  id: '0195f3c4-0000-7000-8000-000000000001',
  sessionId: '0195f3c4-0000-7000-8000-000000000002',
  orgId: null,
  roles: ['authority'],
  email: 'authority@example.test',
  name: 'Authority',
};

/** The service on a fake repository whose collision clock is `clock`. */
function setup(clock: Date | undefined) {
  const list = vi.fn<EncountersRepository['list']>(() => Promise.resolve([]));
  const collisionClock = vi.fn<EncountersRepository['collisionClock']>(() =>
    Promise.resolve(clock),
  );
  const service = new EncountersService(
    { list, collisionClock } as unknown as EncountersRepository,
    {},
  );
  const query = (active: boolean | undefined, cursor?: string) =>
    ({ limit: 50, active, cursor }) as unknown as ListEncountersQuery;
  const filter = (): EncounterFilter | undefined => list.mock.calls.at(-1)?.[0];
  return { service, collisionClock, query, filter };
}

describe('EncountersService active cut-off (event time)', () => {
  it('measures the window back from the collision detector’s clock, not the request time', async () => {
    // AIS position times lag the wall clock: the newest evaluation is 4 min old.
    const clock = new Date(NOW.getTime() - 240_000);
    const { service, query, filter } = setup(clock);
    expect(service.activeWindowMs).toBe(WINDOW_MS);

    await service.list(query(true), authority, NOW);
    expect(filter()?.activity).toEqual({
      active: true,
      since: new Date(clock.getTime() - WINDOW_MS),
    });
    await service.list(query(false), authority, NOW);
    expect(filter()?.activity).toEqual({
      active: false,
      since: new Date(clock.getTime() - WINDOW_MS),
    });
  });

  it('never runs ahead of the request time and falls back to it before the first evaluation', async () => {
    const ahead = setup(new Date(NOW.getTime() + 3_600_000));
    await ahead.service.list(ahead.query(true), authority, NOW);
    expect(ahead.filter()?.activity?.since).toEqual(
      new Date(NOW.getTime() - WINDOW_MS),
    );

    const none = setup(undefined);
    await none.service.list(none.query(true), authority, NOW);
    expect(none.filter()?.activity?.since).toEqual(
      new Date(NOW.getTime() - WINDOW_MS),
    );
  });

  it('reads no clock without `active`, and keeps the cut-off of the first page in the cursor', async () => {
    const clock = new Date(NOW.getTime() - 240_000);
    const { service, collisionClock, query, filter } = setup(clock);
    await service.list(query(undefined), authority, NOW);
    expect(filter()?.activity).toBeUndefined();
    expect(collisionClock).not.toHaveBeenCalled();

    const since = new Date(clock.getTime() - WINDOW_MS);
    const cursor = encodeCursor({
      encounterId: '0195f3c4-0000-7000-8000-0000000000e1',
      from: new Date(NOW.getTime() - 86_400_000).toISOString(),
      to: NOW.toISOString(),
      activeSince: since.toISOString(),
    });
    await service.list(query(true, cursor), authority, NOW);
    expect(filter()?.activity).toEqual({ active: true, since });
    expect(collisionClock).not.toHaveBeenCalled();
  });
});
