import {
  type AlertSeverity,
  classifyEwsStatus,
  EWS_DEFAULT_THRESHOLDS,
  EWS_STATUS,
  ewsAlertSeverity,
  type EwsStatus,
  type EwsThresholds,
  type GeoJsonGeometry,
} from '@darmawanweb/ais-its-contracts/domain';

/** Methodology catalog id of the pipeline Early Warning System. */
export const EWS_METHOD_ID = 'ews.pipeline_distance_status';

/** The nearest active pipeline zone of a position and the distance to its line. */
export interface PipelineProximity {
  readonly zoneId: string;
  /**
   * Distance to the pipeline line, metres, with the semantics of the legacy
   * `@turf/nearest-point-on-line` 7 + `@turf/distance` 7 (sphere of radius
   * 6 371 008.8 m) — the Detector SDK's `'sphere'` distance model.
   */
  readonly distanceM: number;
}

/** Result of {@link assessEws}. */
export interface EwsAssessment {
  /** `0` danger, `1` warning, `3` safe. */
  readonly ewsStatus: EwsStatus;
  /** Distance to the nearest active pipeline, metres; `null` without pipelines. */
  readonly pipelineDistanceM: number | null;
  readonly nearestPipelineZoneId: string | null;
  /** Severity of the `ews` alert (`critical` danger, `warning` warning); `null` when safe. */
  readonly severity: AlertSeverity | null;
}

/**
 * Pipeline Early Warning System status with exact parity to the legacy
 * `checkShipStatus` (be-legacy/src/utils/calculate-ews.ts):
 * `d = dist(p, nearestPointOnLine(L_pipe, p))`; only a vessel predicted at
 * anchor (`predictedNavstatus = 1`) is rated: `d < d_danger` (500 m) → `0`
 * danger, `d < d_warning` (1 750 m) → `1` warning, otherwise `3` safe. v2
 * measures to the nearest of all active `pipeline` zones of the geo service
 * instead of the bundled file; without any pipeline the vessel is safe.
 *
 * The classification itself is the shared contracts `classifyEwsStatus`.
 *
 * @method ews.pipeline_distance_status
 * @param nearest nearest active pipeline zone and the distance to its line (m).
 * @param predictedNavstatus predicted navigational status (`navstatus.prediction`).
 * @param thresholds `EWS_DANGER_M` / `EWS_WARNING_M`, metres (legacy 500 / 1 750).
 * @see docs/METHODOLOGY.md §5.1 (`ews.pipeline_distance_status`)
 * @see pp-27-2021-kelautan-perikanan, permen-esdm-32-2021, ditjen-migas-pipeline-anchoring-1750m, turfjs-7-2
 */
export function assessEws(
  nearest: PipelineProximity | undefined,
  predictedNavstatus: number,
  thresholds: EwsThresholds = EWS_DEFAULT_THRESHOLDS,
): EwsAssessment {
  if (nearest === undefined) {
    return {
      ewsStatus: EWS_STATUS.SAFE,
      pipelineDistanceM: null,
      nearestPipelineZoneId: null,
      severity: null,
    };
  }
  const ewsStatus = classifyEwsStatus(
    nearest.distanceM,
    predictedNavstatus,
    thresholds,
  );
  return {
    ewsStatus,
    pipelineDistanceM: nearest.distanceM,
    nearestPipelineZoneId: nearest.zoneId,
    severity: ewsAlertSeverity(ewsStatus),
  };
}

/** Alert key of an EWS condition (spec §13.7): `ews:<mmsi>:<zoneId>`. */
export function ewsDedupKey(mmsi: number, zoneId: string): string {
  return `ews:${mmsi}:${zoneId}`;
}

/**
 * `true` for the geometries the EWS measures to: lines (`LineString`,
 * `MultiLineString`), as `nearestPointOnLine` in the legacy rule. The geo
 * service only accepts lines for `pipeline` zones.
 */
export function isLineGeometry(geometry: GeoJsonGeometry): boolean {
  return geometry.type === 'LineString' || geometry.type === 'MultiLineString';
}
