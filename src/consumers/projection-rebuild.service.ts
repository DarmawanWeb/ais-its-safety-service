import {
  type AnyEventEnvelope,
  EVENT_TYPES,
  type EventType,
  type StreamName,
  SUBJECT_FILTERS,
} from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { sanitizeError } from '@darmawanweb/ais-its-nest/db';
import { OrderedConsumers } from '@darmawanweb/ais-its-nest/nats';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import { SafetyMetrics } from '../common/safety.metrics.js';
import type { Config } from '../config.js';
import { ProjectionsConsumer } from './projections.consumer.js';
import { VesselsRepository } from './vessels.repository.js';
import { ZonesRepository } from './zones.repository.js';

/** A projection rebuilt from a compacted stream. */
interface ProjectionSpec {
  readonly name: 'zones' | 'vessels';
  readonly stream: StreamName;
  readonly filter: string;
  readonly eventTypes: readonly EventType[];
  /** Applies one event; returns the entity id it concerns. */
  readonly apply: (event: AnyEventEnvelope) => Promise<string | undefined>;
  /** Removes the rows absent from the snapshot. */
  readonly removeAbsent: (
    ids: readonly string[],
    startedAt: Date,
  ) => Promise<number>;
}

/**
 * Rebuilds the `zones` and `vessels` projections from the compacted `GEO`
 * and `FLEET` streams at startup (spec §7.2: one message per entity). An
 * ordered `last_per_subject` replay re-applies every current snapshot (and
 * every deletion still in the stream) and removes the rows the stream no
 * longer knows, so the tables converge after a database restore, a stream
 * reset or a lost delivery — the durable consumers `safety-zones` /
 * `safety-fleet` only resume from their acknowledged position. Both writers
 * are idempotent (newest snapshot wins). A replay that fails or times out is
 * logged and counted; the durable consumers still keep the tables current.
 */
@Injectable()
export class ProjectionRebuildService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProjectionRebuildService.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly ordered: OrderedConsumers,
    private readonly projections: ProjectionsConsumer,
    private readonly zones: ZonesRepository,
    private readonly vessels: VesselsRepository,
    private readonly metrics: SafetyMetrics,
    @InjectConfig() config: Config,
  ) {
    this.timeoutMs = config.PROJECTION_CATCH_UP_TIMEOUT_MS;
  }

  async onApplicationBootstrap(): Promise<void> {
    await Promise.all([
      this.rebuild({
        name: 'zones',
        stream: 'GEO',
        filter: SUBJECT_FILTERS.GEO_ZONE,
        eventTypes: [
          EVENT_TYPES.GEO_ZONE_UPSERTED,
          EVENT_TYPES.GEO_ZONE_DELETED,
        ],
        apply: (event) => this.projections.applyZone(event),
        removeAbsent: (ids, startedAt) =>
          this.zones.deleteAbsent(ids, startedAt),
      }),
      this.rebuild({
        name: 'vessels',
        stream: 'FLEET',
        filter: SUBJECT_FILTERS.FLEET_VESSEL,
        eventTypes: [
          EVENT_TYPES.FLEET_VESSEL_UPSERTED,
          EVENT_TYPES.FLEET_VESSEL_DELETED,
        ],
        apply: (event) => this.projections.applyVessel(event),
        removeAbsent: (ids, startedAt) =>
          this.vessels.deleteAbsent(ids, startedAt),
      }),
    ]);
  }

  /** Replays one compacted stream into its table; never throws. */
  private async rebuild(spec: ProjectionSpec): Promise<void> {
    const startedAt = new Date();
    const seen = new Set<string>();
    let failed = 0;
    try {
      const subscription = await this.ordered.start({
        name: `safety-${spec.name}-rebuild`,
        stream: spec.stream,
        filterSubjects: [spec.filter],
        eventTypes: spec.eventTypes,
        deliver: 'last_per_subject',
        handler: async (event) => {
          try {
            const id = await spec.apply(event);
            if (id !== undefined) seen.add(id);
          } catch (error) {
            failed += 1;
            throw error;
          }
        },
      });
      try {
        await subscription.caughtUp(this.timeoutMs);
      } finally {
        await subscription.stop();
      }
      if (failed > 0)
        throw new Error(`${failed} snapshot(s) could not be applied`);
      const removed = await spec.removeAbsent([...seen], startedAt);
      this.metrics.projectionRebuilds.inc({
        projection: spec.name,
        outcome: 'ok',
      });
      this.logger.log(
        `Rebuilt the ${spec.name} projection from ${spec.stream}: ${seen.size} entities, ${removed} absent removed`,
      );
    } catch (error) {
      this.metrics.projectionRebuilds.inc({
        projection: spec.name,
        outcome: 'failed',
      });
      // Database errors without bound values (the kit's error hygiene): a
      // failed `deleteAbsent` would otherwise log every present entity id.
      const err = sanitizeError(error);
      this.logger.warn({
        msg: `Rebuilding the ${spec.name} projection from ${spec.stream} failed (the durable consumer keeps it current): ${err instanceof Error ? err.message : String(err)}`,
        err,
      });
    }
  }
}
