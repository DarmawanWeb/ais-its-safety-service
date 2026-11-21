import {
  EVENT_TYPES,
  type SafetyVesselStateV1,
} from '@darmawanweb/ais-its-contracts/events';
import { EventPublisher } from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

/** Publication of vessel safety states (an interface so tests can record them). */
export interface SafetyStatePublication {
  publish(state: SafetyVesselStateV1): Promise<void>;
}

/**
 * Publishes `safety.vessel_state.updated.v1` on `safety.state.v1.<mmsi>`
 * (stream `SAFETY`, one message kept per vessel; spec §7.2, §7.3).
 */
@Injectable()
export class SafetyStatePublisher implements SafetyStatePublication {
  constructor(private readonly events: EventPublisher) {}

  async publish(state: SafetyVesselStateV1): Promise<void> {
    await this.events.publishEvent(
      EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED,
      state,
    );
  }
}
