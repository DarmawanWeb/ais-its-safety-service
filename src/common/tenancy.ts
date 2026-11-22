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

/**
 * `true` when a reader of `scope` may see the identity and distance of the
 * pipeline zone owned by `pipelineOrgId` (spec §8.5): global zones
 * (`null`) are shared, an org-owned zone only with that organization and
 * with `authority` / `super_admin`. A reader without organization (`none`,
 * also the shared `SAFETY` stream) sees global zones only.
 */
export function canSeePipeline(
  scope: SafetyReadScope,
  pipelineOrgId: string | null,
): boolean {
  if (pipelineOrgId === null || scope.kind === 'all') return true;
  return scope.kind === 'org' && scope.orgId === pipelineOrgId;
}
