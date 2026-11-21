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

/** Filters of `GET /safety/encounters`. */
export interface EncounterFilter {
  readonly from: Date;
  readonly to: Date;
  readonly risks?: readonly CollisionRisk[] | undefined;
  readonly mmsi?: number | undefined;
  readonly encounterId?: string | undefined;
  /** Keyset position after which to continue (newest first). */
  readonly after?:
    | { readonly time: Date; readonly mmsiA: number; readonly mmsiB: number }
    | undefined;
  readonly limit: number;
}
