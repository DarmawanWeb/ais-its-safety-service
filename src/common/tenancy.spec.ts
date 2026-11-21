import type { Principal } from '@darmawanweb/ais-its-contracts/auth';
import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import { describe, expect, it } from 'vitest';

import { safetyReadScope } from './tenancy.js';

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
