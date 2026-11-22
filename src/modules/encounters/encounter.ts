import type {
  BBox,
  CollisionRisk,
} from '@darmawanweb/ais-its-contracts/domain';

import type { VesselIdentity } from '../../common/vessel-identity.js';
import type { EncounterPositionsJson } from '../../db/schema.js';

/** One CPA/TCPA evaluation of a vessel pair at risk (`encounters` row). */
export interface EncounterSample {
  /** Event time of the evaluation. */
  readonly time: Date;
  /** The lower MMSI of the pair. */
  readonly mmsiA: number;
  /** The higher MMSI of the pair. */
  readonly mmsiB: number;
  /** Groups the samples of one encounter (first band above `none` to the return to `none`). */
  readonly encounterId: string;
  readonly cpaNm: number;
  readonly tcpaMin: number | null;
  readonly rangeNm: number;
  /** Band after hysteresis. */
  readonly risk: CollisionRisk;
  readonly positions: EncounterPositionsJson;
}

/** Where the collision detector stores its samples (a fake in unit tests). */
export interface EncounterSink {
  /** Stores samples; failures are logged and counted, never thrown. */
  record(samples: readonly EncounterSample[]): Promise<void>;
}

/** Injection token of the {@link EncounterSink}. */
export const ENCOUNTER_SINK = 'ENCOUNTER_SINK';

/** One sample of an encounter's history (the pair is the encounter's). */
export type EncounterHistorySample = Omit<
  EncounterSample,
  'mmsiA' | 'mmsiB' | 'encounterId'
>;

/**
 * A collision encounter of a vessel pair — its samples from the first band
 * above `none` to the return to `none` — restricted to a queried time range.
 */
export interface EncounterRecord {
  readonly encounterId: string;
  /** The lower MMSI of the pair. */
  readonly mmsiA: number;
  /** The higher MMSI of the pair. */
  readonly mmsiB: number;
  /** Fleet identity of `mmsiA` (shared across tenants, spec §8.5); `null` when unregistered. */
  readonly vesselA: VesselIdentity | null;
  /** Fleet identity of `mmsiB`; `null` when unregistered. */
  readonly vesselB: VesselIdentity | null;
  /** Time of the first sample in the range. */
  readonly startedAt: Date;
  /** Time of the latest sample in the range. */
  readonly lastSampleAt: Date;
  /** Highest band of the samples in the range. */
  readonly peakRisk: CollisionRisk;
  /** Smallest CPA of the samples in the range, nm. */
  readonly minCpaNm: number;
  /** The samples in the range, oldest first. */
  readonly history: readonly EncounterHistorySample[];
}

/**
 * Keyset position of the encounters list: the last encounter id returned.
 * Ids are UUIDv7 created when the encounter starts, so the order (newest
 * encounter first) never changes while an encounter gets new samples.
 */
export interface EncounterPosition {
  readonly encounterId: string;
}

/** Filters of `GET /safety/encounters`. */
export interface EncounterFilter {
  /** Samples at or after this time. */
  readonly from: Date;
  /** Samples before this time. */
  readonly to: Date;
  /** Only encounters whose peak band in the range is one of these. */
  readonly peakRisks?: readonly CollisionRisk[] | undefined;
  /** Either vessel of the pair. */
  readonly mmsi?: number | undefined;
  readonly encounterId?: string | undefined;
  /**
   * Only encounters with a sample in the range where either vessel's report
   * lies in the box (`[minLon, minLat, maxLon, maxLat]`).
   */
  readonly bbox?: BBox | undefined;
  /**
   * Only active (`active: true`) or only ended (`false`) encounters: an
   * encounter is active while it holds the latest sample of its pair at or
   * after `since` and that sample has a band above `none`
   * ({@link activeEncounterWindowMs}; `since` is in event time). An
   * encounter followed by a newer one of the same pair has ended.
   */
  readonly activity?:
    { readonly active: boolean; readonly since: Date } | undefined;
  /** Keyset position after which to continue. */
  readonly after?: EncounterPosition | undefined;
  readonly limit: number;
}

/** Interval of the collision detector's housekeeping tick (`COLLISION_TICK_MS`), s. */
const HOUSEKEEPING_TICK_S = 30;

/**
 * How long after its latest sample an encounter still counts as active, ms
 * of event time (measured back from the collision detector's newest
 * evaluation, not from the wall clock): the detector stores a sample of an
 * unchanged band at least every `COLLISION_SAMPLE_INTERVAL_S` while the pair
 * is evaluated, and closes a pair not evaluated for `COLLISION_MAX_AGE_S` of
 * event time at its next housekeeping tick (30 s). A pair still tracked
 * therefore has a sample within the sum, and an encounter ended by a band
 * back to `none` has a `none` sample at its end. Encounters closed without a
 * measurement (a vessel excluded or out of range) stay active until the
 * window passes.
 */
export function activeEncounterWindowMs(config: {
  readonly MAX_AGE_S: number;
  readonly SAMPLE_INTERVAL_S: number;
}): number {
  return (
    (config.MAX_AGE_S + config.SAMPLE_INTERVAL_S + HOUSEKEEPING_TICK_S) * 1000
  );
}
