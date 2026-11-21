/** Alert type raised by the `ews` detector (contracts `ALERT_TYPES.ews`). */
export const EWS_ALERT_TYPE = 'ews';

/** Alert type raised by the `collision` detector (contracts `ALERT_TYPES.collision`). */
export const COLLISION_ALERT_TYPE = 'collision';

/**
 * The detector owning each alert type of this service. `AlertRaisedV1` does
 * not carry the detector id, but the `events` table stores it so restored
 * occurrences keep their owner (a detector only sees its own occurrences).
 */
const ALERT_TYPE_OWNERS: Readonly<Record<string, string>> = {
  [EWS_ALERT_TYPE]: 'ews',
  [COLLISION_ALERT_TYPE]: 'collision',
};

/** The detector that raises `type` (a future type is owned by a detector named like it). */
export function detectorOfAlertType(type: string): string {
  return ALERT_TYPE_OWNERS[type] ?? type;
}
