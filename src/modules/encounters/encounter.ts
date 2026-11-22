import type { CollisionRisk } from '@darmawanweb/ais-its-contracts/domain';

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

/** Keyset position of the encounters list (latest sample first). */
export interface EncounterPosition {
  readonly lastSampleAt: Date;
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
  /** Keyset position after which to continue. */
  readonly after?: EncounterPosition | undefined;
  readonly limit: number;
}
