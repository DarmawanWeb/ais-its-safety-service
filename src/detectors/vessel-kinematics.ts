import type {
  VesselPosition,
  VesselState,
} from '@darmawanweb/ais-its-nest/analytics';

import type { VesselKinematics } from '../domain/safety-state.js';

/** The `vessel_state` kinematics of an SDK position or vessel state. */
export function kinematicsOf(
  position: VesselPosition | VesselState,
): VesselKinematics {
  return {
    time: position.time,
    lat: position.lat,
    lon: position.lon,
    sog: position.sog,
    cog: position.cog,
    hdg: position.hdg,
    navstatus: position.navstatus,
    predictedNavstatus: position.predictedNavstatus,
  };
}

/** A vessel's name for alert texts: the fleet name, else its MMSI. */
export function vesselLabel(mmsi: number, name: string | undefined): string {
  return name === undefined ? `MMSI ${mmsi}` : `${name} (MMSI ${mmsi})`;
}
