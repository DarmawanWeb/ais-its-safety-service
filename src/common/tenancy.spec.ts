import type { Principal } from '@darmawanweb/ais-its-contracts/auth';
import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import { describe, expect, it } from 'vitest';

import { canSeePipeline, safetyReadScope } from './tenancy.js';

const ORG = '0195f3c4-0000-7000-8000-00000000000a';

const user = (roles: Role[], orgId: string | null = ORG): Principal => ({
  kind: 'user',
  id: '0195f3c4-0000-7000-8000-000000000001',
  sessionId: '0195f3c4-0000-7000-8000-000000000002',
  orgId,
  roles,
  email: 'user@example.test',
  name: 'User',
});

describe('safetyReadScope (spec §8.5)', () => {
  it('gives authority and super_admin every event', () => {
    expect(safetyReadScope(user(['authority']))).toEqual({ kind: 'all' });
    expect(safetyReadScope(user(['super_admin'], null))).toEqual({
      kind: 'all',
    });
  });

  it('limits other roles to their organization', () => {
    for (const role of ['org_admin', 'fleet_manager', 'viewer'] as const)
      expect(safetyReadScope(user([role]))).toEqual({
        kind: 'org',
        orgId: ORG,
      });
  });

  it('gives a principal without an organization nothing', () => {
    expect(safetyReadScope(user(['viewer'], null))).toEqual({ kind: 'none' });
  });
});

describe('canSeePipeline (spec §8.5: org-owned zones are tenant-private)', () => {
  const OTHER = '0195f3c4-0000-7000-8000-00000000000b';

  it('shares global pipelines with every reader', () => {
    for (const scope of [
      { kind: 'all' },
      { kind: 'org', orgId: ORG },
      { kind: 'none' },
    ] as const)
      expect(canSeePipeline(scope, null)).toBe(true);
  });

  it('shows an org-owned pipeline to its organization and to authority / super_admin only', () => {
    expect(canSeePipeline({ kind: 'org', orgId: ORG }, ORG)).toBe(true);
    expect(canSeePipeline({ kind: 'all' }, ORG)).toBe(true);
    expect(canSeePipeline({ kind: 'org', orgId: OTHER }, ORG)).toBe(false);
    expect(canSeePipeline({ kind: 'none' }, ORG)).toBe(false);
  });
});
