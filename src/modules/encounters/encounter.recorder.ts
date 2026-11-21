import { Injectable, Logger } from '@nestjs/common';

import { SafetyMetrics } from '../../common/safety.metrics.js';
import type { EncounterSample, EncounterSink } from './encounter.js';
import { EncountersRepository } from './encounters.repository.js';

/**
 * The collision detector's {@link EncounterSink}: stores samples in the
 * `encounters` hypertable. History is best effort — a failed insert is
 * logged and counted but never fails the detector call, whose alerts and
 * states matter more.
 */
@Injectable()
export class EncounterRecorder implements EncounterSink {
  private readonly logger = new Logger(EncounterRecorder.name);

  constructor(
    private readonly encounters: EncountersRepository,
    private readonly metrics: SafetyMetrics,
  ) {}

  async record(samples: readonly EncounterSample[]): Promise<void> {
    if (samples.length === 0) return;
    try {
      await this.encounters.insert(samples);
      for (const sample of samples)
        this.metrics.encounterSamples.inc({ risk: sample.risk });
    } catch (error) {
      this.metrics.encounterSampleFailures.inc(samples.length);
      this.logger.warn(
        `Storing ${samples.length} encounter sample(s) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
