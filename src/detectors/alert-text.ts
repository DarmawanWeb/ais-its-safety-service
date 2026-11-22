import { METERS_PER_NM } from '../domain/cpa.js';

/**
 * Localizable texts of this service (platform convention for alert and event
 * text, README "Localizable texts"). Alerts keep their English `title` and
 * `message` (e-mail, webhooks and older clients use them) and carry a stable
 * `messageKey` with its `messageParams` in their `data`; resolutions carry
 * them in their data (`events.resolution`, `alert.resolved.v1.data`), and the
 * REST API adds them to encounters. The web renders the Bahasa Indonesia (or
 * English) text from the key and the values, so a key never changes meaning:
 * a different sentence gets a new key. Keys are constants (never built from
 * user input); the values are flat strings, numbers and booleans whose
 * names carry their unit (spec §5: `…M` metres, `…Nm` nautical miles,
 * `…Min` minutes, `…S` seconds). Distances are given in metres (the
 * coordinator's cross-service convention); collision distances also in
 * nautical miles, the unit of their English sentence.
 */

/** The values a sentence needs. */
export type MessageParams = Readonly<Record<string, string | number | boolean>>;

/** Every key this service produces, `<domain>.<detector>.<situation>` (README table). */
export const MESSAGE_KEYS = {
  /** EWS alert: a vessel predicted at anchor within the warning / danger distance of a pipeline. */
  ewsAnchoredNearPipeline: 'safety.ews.anchored_near_pipeline',
  /** EWS resolution: no longer at anchor within the warning distance. */
  ewsResolvedSafe: 'safety.ews.resolved_safe',
  /** EWS resolution: another pipeline became the nearest one. */
  ewsResolvedOtherPipeline: 'safety.ews.resolved_other_pipeline',
  /** EWS resolution: the pipeline zone was deleted. */
  ewsResolvedZoneDeleted: 'safety.ews.resolved_zone_deleted',
  /** EWS resolution: the zone is no longer an active pipeline with a line geometry. */
  ewsResolvedZoneInactive: 'safety.ews.resolved_zone_inactive',
  /** EWS resolution: the pipeline zone belongs to another organization than the vessel. */
  ewsResolvedZonePrivate: 'safety.ews.resolved_zone_private',
  /** Collision alert: a pair in the band `medium` or `high`. */
  collisionRisk: 'safety.collision.risk',
  /** Collision resolution: the pair's band fell below `medium`. */
  collisionResolvedRisk: 'safety.collision.resolved_risk',
  /** Collision resolution: the pair left the search radius, stopped reporting or was excluded. */
  collisionResolvedPairLost: 'safety.collision.resolved_pair_lost',
  /** Collision resolution: one vessel is excluded from the assessment. */
  collisionResolvedExcluded: 'safety.collision.resolved_excluded',
  /** Collision resolution: an open alert whose pair shows no risk when evaluated again. */
  collisionResolvedNoRisk: 'safety.collision.resolved_no_risk',
  /** Collision resolution: the tracked pair was not evaluated within `COLLISION_MAX_AGE_S`. */
  collisionResolvedStale: 'safety.collision.resolved_stale',
  /** Collision resolution: an open alert whose pair was not evaluated again (after a restart or takeover). */
  collisionResolvedNotEvaluated: 'safety.collision.resolved_not_evaluated',
  /** Collision encounter of the REST API (`GET /safety/encounters`). */
  collisionEncounter: 'safety.collision.encounter',
  /** An EWS event closed by its escalation (a new alert of the same key). */
  ewsEscalated: 'safety.ews.escalated',
  /** An EWS event closed because another event of its key was opened. */
  ewsSuperseded: 'safety.ews.superseded',
  /** A collision event closed by its escalation. */
  collisionEscalated: 'safety.collision.escalated',
  /** A collision event closed because another event of its key was opened. */
  collisionSuperseded: 'safety.collision.superseded',
} as const;

/** A key of {@link MESSAGE_KEYS}. */
export type MessageKey = (typeof MESSAGE_KEYS)[keyof typeof MESSAGE_KEYS];

/** A key with the values of its sentence, as stored in `data`. */
export interface LocalizableText {
  readonly messageKey: MessageKey;
  readonly messageParams: MessageParams;
}

/** `{ messageKey, messageParams }` for spreading into alert or resolution data. */
export function localizable(
  messageKey: MessageKey,
  messageParams: MessageParams = {},
): LocalizableText {
  return { messageKey, messageParams };
}

/** `value` rounded to `digits` decimals as a number, without a negative zero. */
export function rounded(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor || 0;
}

/** A distance in nautical miles as whole metres (the `…M` params). */
export function metresOfNm(nm: number): number {
  return rounded(nm * METERS_PER_NM, 0);
}

const SUPERSEDED_KEYS: Readonly<
  Record<string, Readonly<Record<'escalated' | 'superseded', MessageKey>>>
> = {
  ews: {
    escalated: MESSAGE_KEYS.ewsEscalated,
    superseded: MESSAGE_KEYS.ewsSuperseded,
  },
  collision: {
    escalated: MESSAGE_KEYS.collisionEscalated,
    superseded: MESSAGE_KEYS.collisionSuperseded,
  },
};

/**
 * The text of an event closed because another event of its key was opened
 * (`escalated` or `superseded`), or `undefined` for a detector without keys.
 */
export function supersededText(
  detector: string,
  reason: 'escalated' | 'superseded',
): LocalizableText | undefined {
  const key = SUPERSEDED_KEYS[detector]?.[reason];
  return key === undefined ? undefined : localizable(key);
}
