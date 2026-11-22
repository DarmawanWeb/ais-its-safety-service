import {
  type AlertSeverity,
  EWS_STATUS,
  ewsStatusLabel,
} from '@darmawanweb/ais-its-contracts/domain';
import type { ZoneSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import {
  type Detector,
  type DetectorContext,
  type DetectorVesselChange,
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
  pipelineAppliesTo,
  type PipelineProximity,
} from '../../domain/ews.js';
import {
  SAFETY_STATE_SINK,
  type SafetyStateSink,
} from '../../modules/vessel-states/safety-state.sink.js';
import { ALERT_SIGHTINGS, type AlertSightingSink } from '../alert-sightings.js';
import { DETECTOR_GATE, type DetectorGate } from '../alert-state-sync.js';
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

/** The nearest pipeline of a position: the distance to its line and the zone. */
export interface NearestPipeline extends PipelineProximity {
  readonly zone: ZoneSnapshotV1;
}

/**
 * The nearest active pipeline zone that applies to a vessel of `vesselOrgId`
 * (global zones and the organization's own, {@link pipelineAppliesTo}), with
 * the distance to its line. The runner's `ZoneIndex` uses the `'sphere'`
 * distance model, which reproduces `@turf/nearest-point-on-line` +
 * `@turf/distance` 7 of the legacy rule (verified by the golden tests).
 */
export function nearestPipeline(
  zones: ZoneIndex,
  position: Pick<VesselPosition, 'lat' | 'lon'>,
  vesselOrgId: string | null,
): NearestPipeline | undefined {
  const nearest = zones.nearest(position, {
    kinds: ['pipeline'],
    filter: (zone) =>
      isEwsPipeline(zone) && pipelineAppliesTo(zone.orgId, vesselOrgId),
  });
  return nearest === undefined
    ? undefined
    : {
        zoneId: nearest.zone.id,
        distanceM: nearest.distanceM,
        zone: nearest.zone,
      };
}

/**
 * Pipeline Early Warning System (spec §13.7, legacy `checkShipStatus`
 * parity): for every position, the distance to the nearest active pipeline
 * zone line and the EWS status of a vessel predicted at anchor (0 danger
 * below `EWS_DANGER_M`, 1 warning below `EWS_WARNING_M`, 3 safe). The
 * pipelines are the global ones plus those of the vessel's own organization
 * (spec §8.5: org-owned zones are tenant-private). It reports the EWS part
 * of the vessel's safety state and raises `ews` alerts with
 * `dedupKey = ews:<mmsi>:<zoneId>` on the transition to warning or danger
 * and on escalation (`critical` for danger, `warning` for warning — the
 * emitter publishes nothing while the status is unchanged and records a
 * de-escalation without publishing); the occurrence is resolved when the
 * vessel is safe again, when another pipeline becomes the nearest one, or
 * when its pipeline zone is removed or no longer applies to the vessel.
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
    @Inject(DETECTOR_GATE) private readonly gate: DetectorGate,
    @Inject(ALERT_SIGHTINGS) private readonly sightings: AlertSightingSink,
  ) {}

  onPosition(
    context: DetectorContext<EwsConfig>,
    position: VesselPosition,
  ): Promise<void> {
    return this.gate.position(() => this.evaluate(context, position));
  }

  /** Resolves the open alerts of a pipeline zone that was deleted, deactivated, is no longer a line or became another organization's. */
  onZoneChanged(
    context: DetectorContext<EwsConfig>,
    change: DetectorZoneChange,
  ): Promise<void> {
    return this.gate.run(async () => {
      const { zone } = change;
      const pipeline = change.kind === 'upserted' && isEwsPipeline(zone);
      for (const open of context.alerts.open()) {
        if (open.zoneId !== zone.id) continue;
        if (
          pipeline &&
          pipelineAppliesTo(zone.orgId, context.fleet.orgOf(open.mmsi) ?? null)
        )
          continue;
        await context.alerts.resolve(open.dedupKey, {
          at: context.now(),
          reason:
            change.kind === 'deleted'
              ? 'pipeline zone deleted'
              : pipeline
                ? 'pipeline zone is private to another organization'
                : 'zone is no longer an active pipeline',
        });
      }
    });
  }

  /** Resolves the open alerts on org-owned pipelines that no longer apply to a vessel that changed organization. */
  onVesselChanged(
    context: DetectorContext<EwsConfig>,
    change: DetectorVesselChange,
  ): Promise<void> {
    return this.gate.run(async () => {
      const orgId = context.fleet.orgOf(change.mmsi) ?? null;
      for (const open of context.alerts.open({ mmsi: change.mmsi })) {
        const zone =
          open.zoneId === null ? undefined : context.zones.get(open.zoneId);
        if (zone === undefined || pipelineAppliesTo(zone.orgId, orgId))
          continue;
        await context.alerts.resolve(open.dedupKey, {
          at: context.now(),
          reason: 'pipeline zone is private to another organization',
        });
      }
    });
  }

  private async evaluate(
    context: DetectorContext<EwsConfig>,
    position: VesselPosition,
  ): Promise<void> {
    const thresholds = ewsThresholds(context.config);
    const nearest = nearestPipeline(
      context.zones,
      position,
      context.fleet.orgOf(position.mmsi) ?? null,
    );
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
        nearestPipelineOrgId: nearest?.zone.orgId ?? null,
        evaluatedAt: position.time,
      },
    });

    let activeKey: string | undefined;
    if (assessment.severity !== null && nearest !== undefined) {
      const signal = this.signal(
        context,
        position,
        nearest.zone,
        assessment,
        assessment.severity,
      );
      activeKey = signal.dedupKey;
      const outcome = await context.alerts.raise(signal);
      await this.sightings.record(activeKey, position.time, outcome);
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

  /**
   * The alert of a vessel in warning or danger. The zone is global or the
   * vessel's organization's own, so its name may appear in the texts; the
   * owner organizations are not part of the payload (consumers look them up
   * in their own `FLEET` projection).
   */
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
      },
    } as const;
  }
}
