import type { CollisionRisk } from '@darmawanweb/ais-its-contracts/domain';
import {
  type Counter,
  type Gauge,
  type Histogram,
  MetricsService,
} from '@darmawanweb/ais-its-nest/metrics';
import { Injectable } from '@nestjs/common';

import type { PublicationReason } from '../domain/safety-state.js';

/**
 * Domain metrics of the safety service (spec §10, prefix `aisits_`), next to
 * the kit's HTTP, event and detector metrics.
 */
@Injectable()
export class SafetyMetrics {
  /** `safety.vessel_state.updated.v1` published, by reason. */
  readonly statesPublished: Counter<'reason'>;
  /** States whose publication failed (retried with the next report of the vessel). */
  readonly statePublishFailures: Counter;
  /** Duration of one batched write (upsert + publication) of vessel states. */
  readonly stateFlushDuration: Histogram;
  /** Batched writes that failed (the reports are kept and retried). */
  readonly stateFlushFailures: Counter;
  /** Vessel states waiting to be written. */
  readonly statesPending: Gauge;
  /** Encounter samples stored, by risk band. */
  readonly encounterSamples: Counter<'risk'>;
  /** Encounter samples that could not be stored. */
  readonly encounterSampleFailures: Counter;
  /** Vessel pairs currently tracked by the collision detector, by band. */
  readonly collisionPairs: Gauge<'risk'>;
  /** Projection rebuilds from the compacted streams at startup. */
  readonly projectionRebuilds: Counter<'projection' | 'outcome'>;

  constructor(metrics: MetricsService) {
    this.statesPublished = metrics.counter({
      name: 'safety_states_published_total',
      help: 'Vessel safety states published to the SAFETY stream',
      labelNames: ['reason'],
    });
    this.statePublishFailures = metrics.counter({
      name: 'safety_state_publish_failures_total',
      help: 'Vessel safety states whose publication failed',
    });
    this.stateFlushDuration = metrics.histogram({
      name: 'safety_state_flush_duration_seconds',
      help: 'Duration of a batched vessel state write and publication',
    });
    this.stateFlushFailures = metrics.counter({
      name: 'safety_state_flush_failures_total',
      help: 'Batched vessel state writes that failed and are retried',
    });
    this.statesPending = metrics.gauge({
      name: 'safety_states_pending',
      help: 'Vessel safety states waiting to be written',
    });
    this.encounterSamples = metrics.counter({
      name: 'safety_encounter_samples_total',
      help: 'Collision encounter samples stored',
      labelNames: ['risk'],
    });
    this.encounterSampleFailures = metrics.counter({
      name: 'safety_encounter_sample_failures_total',
      help: 'Collision encounter samples that could not be stored',
    });
    this.collisionPairs = metrics.gauge({
      name: 'safety_collision_pairs',
      help: 'Vessel pairs currently tracked by the collision detector',
      labelNames: ['risk'],
    });
    this.projectionRebuilds = metrics.counter({
      name: 'safety_projection_rebuilds_total',
      help: 'Projection rebuilds from the compacted GEO / FLEET streams at startup',
      labelNames: ['projection', 'outcome'],
    });
  }

  /** Counts a published state. */
  published(reason: PublicationReason): void {
    this.statesPublished.inc({ reason });
  }

  /** Sets the tracked pairs per band. */
  trackedPairs(
    counts: Readonly<Record<Exclude<CollisionRisk, 'none'>, number>>,
  ): void {
    for (const [risk, count] of Object.entries(counts))
      this.collisionPairs.set({ risk }, count);
  }
}
