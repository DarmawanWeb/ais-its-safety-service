import {
  destinationPoint,
  DetectorTestHarness,
  type OpenAlert,
} from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it, vi } from 'vitest';

import {
  RecordingSightings,
  RecordingStateSink,
  TestGate,
  testMetrics,
} from './__testing__/fakes.js';
import { AlertStateSync, resyncGapMs } from './alert-state-sync.js';
import { RESOLVED_ELSEWHERE } from './detector-events.repository.js';
import { EwsDetector } from './ews/ews.detector.js';

const PINNED_TTL_MS = 30_000;
const GAP_MS = resyncGapMs(PINNED_TTL_MS);
const MMSI = 525_005_223;
const ON_LINE = { lat: -6.85, lon: 112.7 };
const warned = {
  mmsi: MMSI,
  ...destinationPoint(ON_LINE, 90, 1000),
  navstatus: 1,
  predictedNavstatus: 1 as const,
  sog: 0.1,
  cog: 12,
};

/** A deferred promise (to hold a detector call open). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The EWS detector behind a real `AlertStateSync` reading `open` as the `events` table. */
async function setup(open: () => readonly OpenAlert[] | Promise<never>) {
  const gate = new TestGate();
  const harness = DetectorTestHarness.create({
    detectors: [
      new EwsDetector(new RecordingStateSink(), gate, new RecordingSightings()),
    ],
    distanceModel: 'sphere',
    alertCooldownMs: 0,
  });
  const source = { loadOpen: vi.fn(() => Promise.resolve(open())) };
  const metrics = testMetrics();
  const sync = new AlertStateSync(
    harness.services.alerts,
    harness.registry,
    source,
    metrics,
    { DETECTOR_PINNED_TTL_MS: PINNED_TTL_MS },
    harness.services.clock,
  );
  gate.bind(sync);
  const zone = await harness.zone({
    kind: 'pipeline',
    geometry: {
      type: 'LineString',
      coordinates: [
        [112.7, -6.9],
        [112.7, -6.8],
      ],
    },
  });
  /** Resyncs counted with `outcome`. */
  const resyncs = async (outcome: string): Promise<number> =>
    (await metrics.alertResyncs.get()).values.find(
      (value) => value.labels.outcome === outcome,
    )?.value ?? 0;
  return { harness, sync, source, zone, resyncs };
}

/** An open row as `DetectorEventsRepository.loadOpen` returns it. */
function openRow(
  overrides: Partial<OpenAlert> & Pick<OpenAlert, 'dedupKey'>,
): OpenAlert {
  const at = new Date('2026-01-01T00:00:00.000Z');
  return {
    alertId: '0195f3c4-0000-7000-8000-0000000000aa',
    type: 'ews',
    mmsi: MMSI,
    relatedMmsi: null,
    zoneId: null,
    severity: 'warning',
    publishedSeverity: 'warning',
    openedAt: at,
    publishedAt: at,
    lastSeenAt: at,
    detector: 'ews',
    ...overrides,
  };
}

describe('AlertStateSync (failover workaround for the kit DetectorRunner)', () => {
  it('derives the gap from the pinned TTL', () => {
    expect(resyncGapMs(30_000)).toBe(15_000);
  });

  it('reloads on the first position and after a gap, not between close positions', async () => {
    const { harness, source } = await setup(() => []);
    await harness.position({ ...warned });
    expect(source.loadOpen).toHaveBeenCalledTimes(1);
    harness.advance(GAP_MS - 1000);
    await harness.position({ ...warned });
    expect(source.loadOpen).toHaveBeenCalledTimes(1);
    harness.advance(GAP_MS);
    await harness.position({ ...warned });
    expect(source.loadOpen).toHaveBeenCalledTimes(2);
  });

  it('raises again a condition another instance resolved meanwhile (no missed alert)', async () => {
    let open: OpenAlert[] = [];
    const { harness, zone } = await setup(() => open);
    await harness.position({ ...warned });
    expect(harness.alertsOf('ews')).toHaveLength(1);
    const first = harness.alertsOf('ews')[0];

    // Another instance resolved it: the events table has no open row.
    open = [];
    harness.advance(GAP_MS + 1000);
    await harness.position({ ...warned });

    expect(harness.resolutions).toEqual([
      expect.objectContaining({
        reason: RESOLVED_ELSEWHERE,
        alert: expect.objectContaining({ alertId: first?.id }) as unknown,
      }),
    ]);
    expect(harness.alertsOf('ews')).toHaveLength(2);
    expect(harness.alertsOf('ews')[1]).toMatchObject({
      dedupKey: `ews:${MMSI}:${zone.id}`,
      severity: 'warning',
    });
  });

  it('does not raise again a condition another instance raised meanwhile (no duplicate)', async () => {
    let open: OpenAlert[] = [];
    const { harness, zone } = await setup(() => open);
    // Active elsewhere: this instance only knew the zone.
    open = [
      openRow({
        dedupKey: `ews:${MMSI}:${zone.id}`,
        zoneId: zone.id,
      }),
    ];
    await harness.position({ ...warned });

    expect(harness.alertsOf('ews')).toEqual([]);
    expect(harness.services.alerts.get(`ews:${MMSI}:${zone.id}`)).toMatchObject(
      { alertId: '0195f3c4-0000-7000-8000-0000000000aa' },
    );
  });

  it('runs the detector resets only when another instance changed the alert state', async () => {
    let open: OpenAlert[] = [];
    const { harness, sync, zone, resyncs } = await setup(() => open);
    const reset = vi.fn();
    sync.onReset(reset);
    await harness.position({ ...warned });
    harness.advance(GAP_MS + 1000);
    open = [...harness.services.alerts.openAlerts()];
    await harness.position({ ...warned });
    expect(reset).not.toHaveBeenCalled();

    harness.advance(GAP_MS + 1000);
    open = [
      openRow({
        dedupKey: `ews:${MMSI}:${zone.id}`,
        zoneId: zone.id,
        severity: 'critical',
        publishedSeverity: 'critical',
      }),
    ];
    await harness.position({ ...warned });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(await resyncs('unchanged')).toBe(2);
    expect(await resyncs('changed')).toBe(1);
  });

  it('ignores the rows of detectors that this instance does not run', async () => {
    const { harness } = await setup(() => [
      openRow({
        dedupKey: 'collision:1:2',
        type: 'collision',
        detector: 'collision',
      }),
    ]);
    await harness.position({ ...warned });
    expect(harness.services.alerts.isOpen('collision:1:2')).toBe(false);
  });

  it('fails the calls while the reload fails and retries with the next call', async () => {
    let failing = true;
    const { harness, source } = await setup(() =>
      failing ? Promise.reject(new Error('database unavailable')) : [],
    );
    await harness.position({ ...warned });
    expect(harness.alertsOf('ews')).toEqual([]);
    expect(harness.logs.join('\n')).toMatch(/database unavailable/);

    failing = false;
    harness.advance(1000);
    await harness.position({ ...warned });
    expect(source.loadOpen).toHaveBeenCalledTimes(2);
    expect(harness.alertsOf('ews')).toHaveLength(1);
  });

  it('waits for running calls before reloading, and holds new calls until it is done', async () => {
    const { harness, sync, source } = await setup(() => []);
    await harness.position({ ...warned });
    harness.advance(GAP_MS + 1000);

    const tick = deferred();
    const running = sync.run(() => tick.promise);
    const order: string[] = [];
    const position = sync.position(() => {
      order.push('position');
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(source.loadOpen).toHaveBeenCalledTimes(1);
    expect(order).toEqual([]);

    tick.resolve();
    await Promise.all([running, position]);
    expect(source.loadOpen).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['position']);
  });
});
