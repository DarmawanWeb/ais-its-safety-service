import {
  type AnyEventEnvelope,
  EVENT_TYPES,
} from '@darmawanweb/ais-its-contracts/events';
import {
  type ConsumerEnvelope,
  EventHandler,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import { VesselsRepository } from './vessels.repository.js';
import { ZonesRepository } from './zones.repository.js';

/**
 * Durable projections of the `GEO` (`safety-zones`) and `FLEET`
 * (`safety-fleet`) streams into the `zones` and `vessels` tables (spec §7.3,
 * §13.7). The detectors read the same streams through the SDK's in-memory
 * `ZoneIndex` / `FleetDirectory`; these tables serve SQL (event and
 * encounter tenancy, vessel names). Idempotent: snapshots apply only when
 * newer, deletions are tombstones.
 */
@Injectable()
export class ProjectionsConsumer {
  private readonly logger = new Logger(ProjectionsConsumer.name);

  constructor(
    private readonly zones: ZonesRepository,
    private readonly vessels: VesselsRepository,
  ) {}

  @EventHandler({ consumer: 'safety-zones' })
  async onZone(event: ConsumerEnvelope<'safety-zones'>): Promise<void> {
    await this.applyZone(event);
  }

  @EventHandler({ consumer: 'safety-fleet' })
  async onVessel(event: ConsumerEnvelope<'safety-fleet'>): Promise<void> {
    await this.applyVessel(event);
  }

  /** Applies a `geo.zone.*` event; returns the zone id it concerns, if any. */
  async applyZone(event: AnyEventEnvelope): Promise<string | undefined> {
    if (event.type === EVENT_TYPES.GEO_ZONE_UPSERTED) {
      if (!(await this.zones.upsert(event.data)))
        this.logger.debug(`Zone ${event.data.id}: older snapshot ignored`);
      return event.data.id;
    }
    if (event.type === EVENT_TYPES.GEO_ZONE_DELETED) {
      await this.zones.markDeleted(event.data.id, new Date(event.time));
      return event.data.id;
    }
    return undefined;
  }

  /** Applies a `fleet.vessel.*` event; returns the vessel id it concerns, if any. */
  async applyVessel(event: AnyEventEnvelope): Promise<string | undefined> {
    if (event.type === EVENT_TYPES.FLEET_VESSEL_UPSERTED) {
      const outcome = await this.vessels.upsert(event.data);
      if (outcome === 'mmsi_taken')
        this.logger.warn(
          `Vessel ${event.data.id}: MMSI ${event.data.mmsi} belongs to a newer vessel, snapshot ignored`,
        );
      else if (outcome === 'stale')
        this.logger.debug(`Vessel ${event.data.id}: older snapshot ignored`);
      return event.data.id;
    }
    if (event.type === EVENT_TYPES.FLEET_VESSEL_DELETED) {
      await this.vessels.markDeleted(event.data, new Date(event.time));
      return event.data.id;
    }
    return undefined;
  }
}
