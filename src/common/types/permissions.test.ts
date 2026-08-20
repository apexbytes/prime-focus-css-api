import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSION_CODES,
  PERMISSION_CATALOGUE,
  SYSTEM_ROLES,
  SUPER_ADMIN_ROLE_CODE,
  resolveRolePermissions,
} from './permissions.js';

describe('permission catalogue', () => {
  it('has no duplicate codes', () => {
    expect(new Set(ALL_PERMISSION_CODES).size).toBe(ALL_PERMISSION_CODES.length);
  });

  it('uses resource:action codes throughout', () => {
    for (const permission of PERMISSION_CATALOGUE) {
      expect(permission.code).toMatch(/^[a-z_]+:[a-z_]+$/);
      expect(permission.description.length).toBeGreaterThan(3);
    }
  });
});

describe('system roles', () => {
  it('defines the four seeded roles', () => {
    expect(SYSTEM_ROLES.map((role) => role.code)).toEqual([
      'super_admin',
      'admin',
      'tier2_specialist',
      'tier1_agent',
    ]);
  });

  it('gives the super administrator every permission, including future ones', () => {
    const superAdmin = SYSTEM_ROLES.find((role) => role.code === SUPER_ADMIN_ROLE_CODE);
    expect(superAdmin).toBeDefined();
    expect(resolveRolePermissions(superAdmin!)).toEqual(ALL_PERMISSION_CODES);
  });

  it('grants only permissions that exist', () => {
    const known = new Set<string>(ALL_PERMISSION_CODES);
    for (const role of SYSTEM_ROLES) {
      for (const code of resolveRolePermissions(role)) {
        expect(known.has(code), `${role.code} grants unknown permission ${code}`).toBe(true);
      }
    }
  });

  it('keeps privilege escalation out of agent roles', () => {
    // A tier-1 agent must not be able to invite staff or rewrite the permission
    // matrix; that is the whole point of having tiers.
    const agent = SYSTEM_ROLES.find((role) => role.code === 'tier1_agent');
    const granted = new Set(resolveRolePermissions(agent!));

    expect(granted.has('user:invite')).toBe(false);
    expect(granted.has('user:manage')).toBe(false);
    expect(granted.has('role:manage')).toBe(false);
    expect(granted.has('api_key:manage')).toBe(false);
    expect(granted.has('audit:read')).toBe(false);
    // But it must be able to do the job.
    expect(granted.has('ticket:read')).toBe(true);
    expect(granted.has('ticket:reply')).toBe(true);
  });

  it('does not let an administrator manage roles', () => {
    // Only super_admin edits the permission model, so an admin cannot grant
    // themselves more than they were given.
    const admin = SYSTEM_ROLES.find((role) => role.code === 'admin');
    const granted = new Set(resolveRolePermissions(admin!));

    expect(granted.has('role:read')).toBe(true);
    expect(granted.has('role:manage')).toBe(false);
  });
});
