import { describe, expect, it, vi } from 'vitest';

import { AlertSightings, SIGHTING_INTERVAL_MS } from './alert-sightings.js';

const KEY = 'ews:525005223:0195f3c4-0000-7000-8000-000000000001';
const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms);

function setup(recordSighting = vi.fn(() => Promise.resolve())) {
  return { sightings: new AlertSightings({ recordSighting }), recordSighting };
}

describe('AlertSightings (events.last_seen_at in event time)', () => {
  it('writes nothing for new alerts and escalations (their row carries occurredAt)', async () => {
    const { sightings, recordSighting } = setup();
    await sightings.record(KEY, at(0), 'raised');
    await sightings.record(KEY, at(1000), 'escalated');
    expect(recordSighting).not.toHaveBeenCalled();
  });

  it('records repeats of an unchanged severity at most once per interval', async () => {
    const { sightings, recordSighting } = setup();
    await sightings.record(KEY, at(0), 'raised');
    await sightings.record(KEY, at(SIGHTING_INTERVAL_MS - 1), 'unchanged');
    expect(recordSighting).not.toHaveBeenCalled();
    await sightings.record(KEY, at(SIGHTING_INTERVAL_MS), 'unchanged');
    await sightings.record(KEY, at(SIGHTING_INTERVAL_MS + 1000), 'unchanged');
    expect(recordSighting.mock.calls).toEqual([
      [KEY, at(SIGHTING_INTERVAL_MS)],
    ]);
  });

  it('records the first repeat of a key it does not know (restart, takeover) at once', async () => {
    const { sightings, recordSighting } = setup();
    await sightings.record(KEY, at(5000), 'unchanged');
    expect(recordSighting.mock.calls).toEqual([[KEY, at(5000)]]);
  });

  it('records de-escalations and suppressed re-raises at once', async () => {
    const { sightings, recordSighting } = setup();
    await sightings.record(KEY, at(0), 'raised');
    await sightings.record(KEY, at(1000), 'de-escalated');
    await sightings.record(KEY, at(2000), 'suppressed');
    expect(recordSighting.mock.calls).toEqual([
      [KEY, at(1000)],
      [KEY, at(2000)],
    ]);
  });

  it('never throws: a failed write is retried by the next sighting', async () => {
    const recordSighting = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(undefined);
    const { sightings } = setup(recordSighting);
    await expect(
      sightings.record(KEY, at(0), 'unchanged'),
    ).resolves.toBeUndefined();
    await sightings.record(KEY, at(1000), 'unchanged');
    expect(recordSighting).toHaveBeenCalledTimes(2);
  });
});
