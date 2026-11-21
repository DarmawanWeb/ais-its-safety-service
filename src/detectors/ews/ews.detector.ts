import {
  type AlertSeverity,
  EWS_STATUS,
  ewsStatusLabel,
} from '@darmawanweb/ais-its-contracts/domain';
import type { ZoneSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import {
  type Detector,
  type DetectorContext,
  type DetectorZoneChange,
  RegisterDetector,
  type VesselPosition,
  type ZoneIndex,
} from '@darmawanweb/ais-its-nest/analytics';
import { Inject, Injectable } from '@nestjs/common';

import {
  assessEws,
  type EwsAssessment,
  ewsDedupKey,
  EWS_METHOD_ID,
  isLineGeometry,
  type PipelineProximity,
} from '../../domain/ews.js';
import {
  SAFETY_STATE_SINK,
  type SafetyStateSink,
} from '../../modules/vessel-states/safety-state.sink.js';
import { EWS_ALERT_TYPE } from '../alert-types.js';
import { kinematicsOf, vesselLabel } from '../vessel-kinematics.js';
import {
  type EwsConfig,
  ewsConfigSchema,
  ewsThresholds,
} from './ews.config.js';

/** `true` for zones the EWS measures to: active `pipeline` zones with a line geometry. */
export function isEwsPipeline(zone: ZoneSnapshotV1): boolean {
  return (
    zone.active && zone.kind === 'pipeline' && isLineGeometry(zone.geometry)
  );
}

/**
 * The nearest active pipeline zone of a position, with the distance to its
 * line. The runner's `ZoneIndex` uses the `'sphere'` distance model, which
 * reproduces `@turf/nearest-point-on-line` + `@turf/distance` 7 of the
 * legacy rule (verified by the golden tests).
 */
export function nearestPipeline(
  zones: ZoneIndex,
  position: Pick<VesselPosition, 'lat' | 'lon'>,
): PipelineProximity | undefined {
  const nearest = zones.nearest(position, {
    kinds: ['pipeline'],
    filter: isEwsPipeline,
  });
  return nearest === undefined
    ? undefined
    : { zoneId: nearest.zone.id, distanceM: nearest.distanceM };
}

/**
 * Pipeline Early Warning System (spec §13.7, legacy `checkShipStatus`
 * parity): for every position, the distance to the nearest active pipeline
 * zone line and the EWS status of a vessel predicted at anchor (0 danger
 * below `EWS_DANGER_M`, 1 warning below `EWS_WARNING_M`, 3 safe). It reports
 * the EWS part of the vessel's safety state and raises `ews` alerts with
 * `dedupKey = ews:<mmsi>:<zoneId>` on the transition to warning or danger
 * and on escalation (`critical` for danger, `warning` for warning — the
 * emitter publishes nothing while the status is unchanged and records a
 * de-escalation without publishing); the occurrence is resolved when the
 * vessel is safe again, when another pipeline becomes the nearest one, or
 * when its pipeline zone is removed.
 *
 * @method ews.pipeline_distance_status
 * @see docs/METHODOLOGY.md §5.1 (`ews.pipeline_distance_status`)
 * @see be-legacy/src/utils/calculate-ews.ts (checkShipStatus)
 */
@RegisterDetector()
@Injectable()
export class EwsDetector implements Detector<EwsConfig> {
  readonly id = 'ews';
  readonly domain = 'safety';
  readonly methodIds = [EWS_METHOD_ID];
  readonly alertTypes = [EWS_ALERT_TYPE] as const;
  readonly configSchema = ewsConfigSchema;

  constructor(
    @Inject(SAFETY_STATE_SINK) private readonly states: SafetyStateSink,
  ) {}

  async onPosition(
    context: DetectorContext<EwsConfig>,
    position: VesselPosition,
  ): Promise<void> {
    const thresholds = ewsThresholds(context.config);
    const nearest = nearestPipeline(context.zones, position);
    const assessment = assessEws(
      nearest,
      position.predictedNavstatus,
      thresholds,
    );
    this.states.report({
      mmsi: position.mmsi,
      kinematics: kinematicsOf(position),
      ews: {
        ewsStatus: assessment.ewsStatus,
        pipelineDistanceM: assessment.pipelineDistanceM,
        nearestPipelineZoneId: assessment.nearestPipelineZoneId,
        evaluatedAt: position.time,
      },
    });

    const zone =
      nearest === undefined ? undefined : context.zones.get(nearest.zoneId);
    let activeKey: string | undefined;
    if (assessment.severity !== null && zone !== undefined) {
      activeKey = ewsDedupKey(position.mmsi, zone.id);
      await context.alerts.raise(
        this.signal(context, position, zone, assessment, assessment.severity),
      );
    }
    for (const open of context.alerts.open({ mmsi: position.mmsi })) {
      if (open.dedupKey === activeKey) continue;
      await context.alerts.resolve(open.dedupKey, {
        at: position.time,
        reason:
          assessment.ewsStatus === EWS_STATUS.SAFE
            ? 'safe: not at anchor within the warning distance'
            : 'another pipeline is nearer',
        data: {
          ewsStatus: assessment.ewsStatus,
          pipelineDistanceM: assessment.pipelineDistanceM,
          nearestPipelineZoneId: assessment.nearestPipelineZoneId,
          predictedNavstatus: position.predictedNavstatus,
        },
      });
    }
  }

  /** Resolves the open alerts of a pipeline zone that was deleted, deactivated or is no longer a pipeline line. */
  async onZoneChanged(
    context: DetectorContext<EwsConfig>,
    change: DetectorZoneChange,
  ): Promise<void> {
    if (change.kind === 'upserted' && isEwsPipeline(change.zone)) return;
    for (const open of context.alerts.open()) {
      if (open.zoneId !== change.zone.id) continue;
      await context.alerts.resolve(open.dedupKey, {
        at: context.now(),
        reason:
          change.kind === 'deleted'
            ? 'pipeline zone deleted'
            : 'zone is no longer an active pipeline',
      });
    }
  }

  private signal(
    context: DetectorContext<EwsConfig>,
    position: VesselPosition,
    zone: ZoneSnapshotV1,
    assessment: EwsAssessment,
    severity: AlertSeverity,
  ) {
    const vessel = vesselLabel(
      position.mmsi,
      context.fleet.byMmsi(position.mmsi)?.name,
    );
    const distanceM = assessment.pipelineDistanceM ?? 0;
    const status = ewsStatusLabel(assessment.ewsStatus);
    return {
      type: EWS_ALERT_TYPE,
      dedupKey: ewsDedupKey(position.mmsi, zone.id),
      severity,
      mmsi: position.mmsi,
      title: `Pipeline ${status.toLowerCase()}: ${vessel}`,
      message: `${vessel} is predicted at anchor ${Math.round(distanceM)} m from pipeline ${zone.name} (${status.toLowerCase()} below ${assessment.ewsStatus === EWS_STATUS.DANGER ? context.config.DANGER_M : context.config.WARNING_M} m)`,
      position,
      occurredAt: position.time,
      zoneId: zone.id,
      data: {
        methodId: EWS_METHOD_ID,
        ewsStatus: assessment.ewsStatus,
        pipelineDistanceM: assessment.pipelineDistanceM,
        zoneId: zone.id,
        zoneCode: zone.code,
        zoneName: zone.name,
        thresholds: ewsThresholds(context.config),
        predictedNavstatus: position.predictedNavstatus,
        navstatus: position.navstatus,
        sog: position.sog,
        orgId: context.fleet.orgOf(position.mmsi) ?? null,
      },
    } as const;
  }
}
