import { EWS_METHOD_ID } from '../../domain/ews.js';
import { COLLISION_METHOD_ID } from '../../domain/safety-state.js';

/**
 * Ids of the methodology catalog methods this service implements
 * (docs/references/methods.json, docs/PLATFORM_SPEC.md §17). Keep it in sync
 * with the `@method` TSDoc tags of the implementing functions and with the
 * README section "Methodology & references".
 */
export const IMPLEMENTED_METHOD_IDS: readonly string[] = [
  EWS_METHOD_ID,
  COLLISION_METHOD_ID,
];
