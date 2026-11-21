import {
  type CollisionRisk,
  compareCollisionRisk,
  newId,
} from '@darmawanweb/ais-its-contracts/domain';
import type { ClosestEncounter } from '@darmawanweb/ais-its-contracts/events';

import type { EncounterPositionsJson } from '../../db/schema.js';
import type { RiskMeasurement } from '../../domain/collision-risk.js';

/** A band a tracked pair can be in. */
export type TrackedRisk = Exclude<CollisionRisk, 'none'>;

/** One evaluation of a pair: CPA/TCPA, range and the two reports it used. */
export interface PairMeasurement extends RiskMeasurement {
  /** Present range, nm. */
  readonly rangeNm: number;
  /** Event time of the evaluation. */
  readonly at: Date;
  /** The reports of both vessels (`a` = lower MMSI). */
  readonly positions: EncounterPositionsJson;
}

/** A pair with a band above `none`. */
export interface TrackedEncounter {
  /** `collision:<mmsiA>:<mmsiB>` (also the alert key). */
  readonly key: string;
  /** Groups the stored samples of this encounter. */
  readonly encounterId: string;
  readonly mmsiA: number;
  readonly mmsiB: number;
  readonly risk: TrackedRisk;
  /** The latest evaluation (its TCPA is defined: only such pairs have a band). */
  readonly measurement: PairMeasurement & { readonly tcpaMin: number };
  readonly startedAt: Date;
  /** When the last sample of the encounter was stored. */
  readonly lastSampleAt: Date | undefined;
}

/** What one evaluation or closure did to a pair. */
export interface EncounterTransition {
  readonly key: string;
  readonly encounterId: string;
  readonly mmsiA: number;
  readonly mmsiB: number;
  readonly before: CollisionRisk;
  readonly after: CollisionRisk;
  /** The evaluation; `undefined` when the pair was closed without one (stale, out of range). */
  readonly measurement: PairMeasurement | undefined;
  /** `true` when the evaluation is to be stored as an encounter sample. */
  readonly sample: boolean;
}

/** Collision part of a vessel's state: its highest band and the encounter behind it. */
export interface VesselCollisionSummary {
  readonly risk: CollisionRisk;
  readonly closest: ClosestEncounter | null;
}

const NO_RISK: VesselCollisionSummary = { risk: 'none', closest: null };

/**
 * In-memory state of the collision detector: the vessel pairs with a risk
 * band above `none`, indexed by vessel. Evaluations older than the pair's
 * latest one are ignored (positions of different vessels are handled
 * concurrently and may arrive out of order), so the tracked band always
 * follows the newest evaluation.
 */
export class EncounterTracker {
  private readonly encounters = new Map<string, TrackedEncounter>();
  private readonly byVessel = new Map<number, Set<string>>();

  constructor(private readonly createId: () => string = newId) {}

  /** Number of tracked pairs. */
  get size(): number {
    return this.encounters.size;
  }

  get(key: string): TrackedEncounter | undefined {
    return this.encounters.get(key);
  }

  has(key: string): boolean {
    return this.encounters.has(key);
  }

  /** Keys of the pairs a vessel belongs to. */
  keysOf(mmsi: number): string[] {
    return [...(this.byVessel.get(mmsi) ?? [])];
  }

  /**
   * Applies the band of an evaluation of the pair `key`.
   *
   * @param sampleIntervalMs minimum interval between two samples of an unchanged band.
   * @returns the transition, or `undefined` when the evaluation is older than
   *   the tracked one or the pair stays untracked (`none`).
   */
  apply(
    key: string,
    mmsiA: number,
    mmsiB: number,
    risk: CollisionRisk,
    measurement: PairMeasurement,
    sampleIntervalMs: number,
  ): EncounterTransition | undefined {
    const existing = this.encounters.get(key);
    if (
      existing !== undefined &&
      measurement.at.getTime() < existing.measurement.at.getTime()
    ) {
      return undefined;
    }
    const tcpaMin = measurement.tcpaMin;
    if (risk === 'none' || tcpaMin === null) {
      if (existing === undefined) return undefined;
      this.remove(existing);
      return {
        key,
        encounterId: existing.encounterId,
        mmsiA,
        mmsiB,
        before: existing.risk,
        after: 'none',
        measurement,
        sample: true,
      };
    }
    const lastSampleAt = existing?.lastSampleAt;
    const sample =
      existing?.risk !== risk ||
      lastSampleAt === undefined ||
      measurement.at.getTime() - lastSampleAt.getTime() >= sampleIntervalMs;
    const next: TrackedEncounter = {
      key,
      encounterId: existing?.encounterId ?? this.createId(),
      mmsiA,
      mmsiB,
      risk,
      measurement: { ...measurement, tcpaMin },
      startedAt: existing?.startedAt ?? measurement.at,
      lastSampleAt: sample ? measurement.at : lastSampleAt,
    };
    this.encounters.set(key, next);
    this.index(mmsiA, key);
    this.index(mmsiB, key);
    return {
      key,
      encounterId: next.encounterId,
      mmsiA,
      mmsiB,
      before: existing?.risk ?? 'none',
      after: risk,
      measurement,
      sample,
    };
  }

  /** Ends a tracked pair without an evaluation (stale, out of range, excluded). */
  close(key: string): EncounterTransition | undefined {
    const existing = this.encounters.get(key);
    if (existing === undefined) return undefined;
    this.remove(existing);
    return {
      key,
      encounterId: existing.encounterId,
      mmsiA: existing.mmsiA,
      mmsiB: existing.mmsiB,
      before: existing.risk,
      after: 'none',
      measurement: undefined,
      sample: false,
    };
  }

  /** Tracked pairs whose latest evaluation is older than `cutoff` (event time). */
  staleBefore(cutoff: Date): TrackedEncounter[] {
    return [...this.encounters.values()].filter(
      (encounter) => encounter.measurement.at.getTime() < cutoff.getTime(),
    );
  }

  /**
   * Collision part of a vessel's state: the highest band among its pairs
   * and, as closest encounter, the pair of that band with the smallest CPA.
   */
  summaryOf(mmsi: number): VesselCollisionSummary {
    let best: TrackedEncounter | undefined;
    for (const key of this.byVessel.get(mmsi) ?? []) {
      const encounter = this.encounters.get(key);
      if (encounter === undefined) continue;
      if (
        best === undefined ||
        compareCollisionRisk(encounter.risk, best.risk) > 0 ||
        (encounter.risk === best.risk &&
          encounter.measurement.cpaNm < best.measurement.cpaNm)
      ) {
        best = encounter;
      }
    }
    if (best === undefined) return NO_RISK;
    return {
      risk: best.risk,
      closest: {
        otherMmsi: best.mmsiA === mmsi ? best.mmsiB : best.mmsiA,
        cpaNm: best.measurement.cpaNm,
        tcpaMin: best.measurement.tcpaMin,
      },
    };
  }

  /** Tracked pairs per band (metrics). */
  counts(): Record<TrackedRisk, number> {
    const counts: Record<TrackedRisk, number> = { low: 0, medium: 0, high: 0 };
    for (const encounter of this.encounters.values())
      counts[encounter.risk] += 1;
    return counts;
  }

  private index(mmsi: number, key: string): void {
    let keys = this.byVessel.get(mmsi);
    if (keys === undefined) {
      keys = new Set();
      this.byVessel.set(mmsi, keys);
    }
    keys.add(key);
  }

  private remove(encounter: TrackedEncounter): void {
    this.encounters.delete(encounter.key);
    for (const mmsi of [encounter.mmsiA, encounter.mmsiB]) {
      const keys = this.byVessel.get(mmsi);
      keys?.delete(encounter.key);
      if (keys?.size === 0) this.byVessel.delete(mmsi);
    }
  }
}

/** `true` when two summaries publish the same state category (band and other vessel). */
export function sameCollisionCategory(
  a: VesselCollisionSummary,
  b: VesselCollisionSummary,
): boolean {
  return (
    a.risk === b.risk &&
    (a.closest?.otherMmsi ?? null) === (b.closest?.otherMmsi ?? null)
  );
}
