import type {
  CollisionReset,
  SafetyStateReport,
} from '../../domain/safety-state.js';

/**
 * Where detectors report their part of a vessel's safety state. The
 * production sink ({@link SafetyStateWriter}) merges, stores and publishes the
 * reports in the background; unit tests pass a recording fake.
 */
export interface SafetyStateSink {
  /** Queues a report; never throws and never waits for I/O. */
  report(report: SafetyStateReport): void;
  /**
   * Queues the fall-back of a vessel's stored collision part to `none`
   * (merged with the vessel's reports, newest part wins); never throws and
   * never waits for I/O.
   */
  resetCollision(reset: CollisionReset): void;
}

/** Injection token of the {@link SafetyStateSink}. */
export const SAFETY_STATE_SINK = 'SAFETY_STATE_SINK';
