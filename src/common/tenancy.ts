import {
  hasAuthorityAccess,
  type Principal,
} from '@darmawanweb/ais-its-contracts/auth';

/**
 * Which safety events and encounters a principal may read (spec §8.5):
 * `authority` and `super_admin` read all of them; any other principal only
 * those whose `mmsi` (or `relatedMmsi`) belongs to a vessel of its active
 * organization; a principal without an organization reads none.
 */
export type SafetyReadScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'org'; readonly orgId: string }
  | { readonly kind: 'none' };

/** The {@link SafetyReadScope} of a principal. */
export function safetyReadScope(principal: Principal): SafetyReadScope {
  if (hasAuthorityAccess(principal)) return { kind: 'all' };
  if (principal.orgId === null) return { kind: 'none' };
  return { kind: 'org', orgId: principal.orgId };
}
