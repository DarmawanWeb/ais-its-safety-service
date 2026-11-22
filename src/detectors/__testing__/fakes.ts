import type { AlertOutcome } from '@darmawanweb/ais-its-nest/analytics';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';

import { SafetyMetrics } from '../../common/safety.metrics.js';
import type { SafetyStateReport } from '../../domain/safety-state.js';
import type {
  EncounterSample,
  EncounterSink,
} from '../../modules/encounters/encounter.js';
import type { SafetyStateSink } from '../../modules/vessel-states/safety-state.sink.js';
import type { AlertSightingSink } from '../alert-sightings.js';
import type { DetectorGate } from '../alert-state-sync.js';

/** Records the detectors' state reports (unit tests). */
export class RecordingStateSink implements SafetyStateSink {
  readonly reports: SafetyStateReport[] = [];

  report(report: SafetyStateReport): void {
    this.reports.push(report);
  }

  /** The latest report of a vessel. */
  last(mmsi: number): SafetyStateReport | undefined {
    return this.reports.filter((report) => report.mmsi === mmsi).at(-1);
  }

  /** Reports of a vessel. */
  of(mmsi: number): SafetyStateReport[] {
    return this.reports.filter((report) => report.mmsi === mmsi);
  }
}

/** Records the collision detector's encounter samples (unit tests). */
export class RecordingEncounterSink implements EncounterSink {
  readonly samples: EncounterSample[] = [];

  record(samples: readonly EncounterSample[]): Promise<void> {
    this.samples.push(...samples);
    return Promise.resolve();
  }
}

/** Service metrics on a private registry. */
export function testMetrics(): SafetyMetrics {
  return new SafetyMetrics(new MetricsService());
}

/**
 * A {@link DetectorGate} that runs every call at once, or through `target`
 * once a test binds one (an `AlertStateSync` needs the harness's emitter,
 * which exists only after the detectors were constructed).
 */
export class TestGate implements DetectorGate {
  target: DetectorGate | undefined;
  private readonly resets: (() => void)[] = [];

  position<T>(call: () => Promise<T>): Promise<T> {
    return this.target?.position(call) ?? call();
  }

  run<T>(call: () => Promise<T>): Promise<T> {
    return this.target?.run(call) ?? call();
  }

  onReset(reset: () => void): void {
    this.resets.push(reset);
    this.target?.onReset(reset);
  }

  /** Runs the registered resets, as a resync after a takeover does. */
  triggerResets(): void {
    for (const reset of this.resets) reset();
  }

  /** Binds `target` and hands it the resets registered so far. */
  bind(target: DetectorGate): void {
    this.target = target;
    for (const reset of this.resets) target.onReset(reset);
  }
}

/** Records the outcomes the detectors report (unit tests). */
export class RecordingSightings implements AlertSightingSink {
  readonly records: {
    readonly dedupKey: string;
    readonly seenAt: Date;
    readonly outcome: AlertOutcome;
  }[] = [];

  record(dedupKey: string, seenAt: Date, outcome: AlertOutcome): Promise<void> {
    this.records.push({ dedupKey, seenAt, outcome });
    return Promise.resolve();
  }
}
