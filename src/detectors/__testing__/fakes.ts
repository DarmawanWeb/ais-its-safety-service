import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';

import { SafetyMetrics } from '../../common/safety.metrics.js';
import type { SafetyStateReport } from '../../domain/safety-state.js';
import type {
  EncounterSample,
  EncounterSink,
} from '../../modules/encounters/encounter.js';
import type { SafetyStateSink } from '../../modules/vessel-states/safety-state.sink.js';

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
