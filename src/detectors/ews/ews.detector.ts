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
  type OpenAlert,
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
import {
  type LocalizableText,
  localizable,
  MESSAGE_KEYS,
} from '../alert-text.js';
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

/** Why an open EWS occurrence ended without a position (its zone changed). */
interface ZoneEnd {
  readonly reason: string;
  readonly text: LocalizableText;
}

const ZONE_DELETED: ZoneEnd = {
  reason: 'pipeline zone deleted',
  text: localizable(MESSAGE_KEYS.ewsResolvedZoneDeleted),
};
const ZONE_INACTIVE: ZoneEnd = {
  reason: 'zone is no longer an active pipeline',
  text: localizable(MESSAGE_KEYS.ewsResolvedZoneInactive),
};
const ZONE_PRIVATE: ZoneEnd = {
  reason: 'pipeline zone is private to another organization',
  text: localizable(MESSAGE_KEYS.ewsResolvedZonePrivate),
};

/**
 * Why the pipeline of an open occurrence no longer applies to its vessel of
 * `vesselOrgId`: deleted (`zone` undefined), no longer an active pipeline
 * with a line geometry, or another organization's zone; `undefined` while it
 * still applies.
 */
export function zoneEndOf(
  zone: ZoneSnapshotV1 | undefined,
  vesselOrgId: string | null,
): ZoneEnd | undefined {
  if (zone === undefined) return ZONE_DELETED;
  if (!isEwsPipeline(zone)) return ZONE_INACTIVE;
  if (!pipelineAppliesTo(zone.orgId, vesselOrgId)) return ZONE_PRIVATE;
  return undefined;
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
 * Resolutions are announced with `alert.resolved.v1` by the runner (after
 * the alert cooldown since the last raise).
 *
 * Zone and vessel changes reach every instance, but only the active one
 * (`context.isActive()`) resolves alerts there: a standby holds no current
 * alert state. When an instance becomes active (`onActivated`, after the
 * runner reloaded the open occurrences from `events`), it resolves the open
 * occurrences whose pipeline changed while no instance acted on it.
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

  onPosition(
    context: DetectorContext<EwsConfig>,
    position: VesselPosition,
  ): Promise<void> {
    return this.evaluate(context, position);
  }

  /**
   * Resolves the open occurrences whose pipeline zone was deleted, changed
   * or became another organization's while no instance acted on it (e.g. a
   * zone deleted while this instance was a standby). Runs on activation,
   * after the open occurrences were reloaded.
   */
  async onActivated(context: DetectorContext<EwsConfig>): Promise<void> {
    for (const open of context.alerts.open()) {
      const end = zoneEndOf(
        open.zoneId === null ? undefined : context.zones.get(open.zoneId),
        context.fleet.orgOf(open.mmsi) ?? null,
      );
      if (end !== undefined) await this.resolveForZone(context, open, end);
    }
  }

  /** Resolves the open alerts of a pipeline zone that was deleted, deactivated, is no longer a line or became another organization's. */
  async onZoneChanged(
    context: DetectorContext<EwsConfig>,
    change: DetectorZoneChange,
  ): Promise<void> {
    if (!context.isActive()) return;
    const zone = change.kind === 'deleted' ? undefined : change.zone;
    for (const open of context.alerts.open()) {
      if (open.zoneId !== change.zone.id) continue;
      const end = zoneEndOf(zone, context.fleet.orgOf(open.mmsi) ?? null);
      if (end !== undefined) await this.resolveForZone(context, open, end);
    }
  }

  /** Resolves the open alerts on org-owned pipelines that no longer apply to a vessel that changed organization. */
  async onVesselChanged(
    context: DetectorContext<EwsConfig>,
    change: DetectorVesselChange,
  ): Promise<void> {
    if (!context.isActive()) return;
    const orgId = context.fleet.orgOf(change.mmsi) ?? null;
    for (const open of context.alerts.open({ mmsi: change.mmsi })) {
      const zone =
        open.zoneId === null ? undefined : context.zones.get(open.zoneId);
      // A missing zone is handled by its deletion (or the next position).
      if (zone === undefined || pipelineAppliesTo(zone.orgId, orgId)) continue;
      await this.resolveForZone(context, open, ZONE_PRIVATE);
    }
  }

  /** Resolves an occurrence that ended by a zone or vessel change (detector clock). */
  private async resolveForZone(
    context: DetectorContext<EwsConfig>,
    open: OpenAlert,
    end: ZoneEnd,
  ): Promise<void> {
    await context.alerts.resolve(open.dedupKey, {
      at: context.now(),
      reason: end.reason,
      data: { ...end.text },
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
      await context.alerts.raise(signal);
    }
    for (const open of context.alerts.open({ mmsi: position.mmsi })) {
      if (open.dedupKey === activeKey) continue;
      const safe = assessment.ewsStatus === EWS_STATUS.SAFE;
      await context.alerts.resolve(open.dedupKey, {
        at: position.time,
        reason: safe
          ? 'safe: not at anchor within the warning distance'
          : 'another pipeline is nearer',
        data: {
          ewsStatus: assessment.ewsStatus,
          pipelineDistanceM: assessment.pipelineDistanceM,
          nearestPipelineZoneId: assessment.nearestPipelineZoneId,
          predictedNavstatus: position.predictedNavstatus,
          ...localizable(
            safe
              ? MESSAGE_KEYS.ewsResolvedSafe
              : MESSAGE_KEYS.ewsResolvedOtherPipeline,
          ),
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
    const distanceM = Math.round(assessment.pipelineDistanceM ?? 0);
    const status = ewsStatusLabel(assessment.ewsStatus).toLowerCase();
    const thresholdM =
      assessment.ewsStatus === EWS_STATUS.DANGER
        ? context.config.DANGER_M
        : context.config.WARNING_M;
    return {
      type: EWS_ALERT_TYPE,
      dedupKey: ewsDedupKey(position.mmsi, zone.id),
      severity,
      mmsi: position.mmsi,
      title: `Pipeline ${status}: ${vessel}`,
      message: `${vessel} is predicted at anchor ${distanceM} m from pipeline ${zone.name} (${status} below ${thresholdM} m)`,
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
        ...localizable(MESSAGE_KEYS.ewsAnchoredNearPipeline, {
          vessel,
          mmsi: position.mmsi,
          status,
          distanceM,
          thresholdM,
          zoneCode: zone.code,
          zoneName: zone.name,
        }),
      },
    } as const;
  }
}
