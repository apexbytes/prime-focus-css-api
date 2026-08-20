import { AppError, ErrorCode } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { SUPER_ADMIN_ROLE_CODE, type PermissionCode } from '../../common/types/permissions.js';
import { withTransaction, type Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as auditService from '../audit/audit.service.js';
import * as repository from './role.repository.js';
import type {
  CreateRoleInput,
  RoleRow,
  RoleWithPermissions,
  UpdateRoleInput,
} from './role.types.js';

const log = createModuleLogger('role');

/**
 * Permission lookups happen on every authenticated request, so the role → codes
 * mapping is cached in-process. The TTL is short because a revoked permission
 * that lingers is a security problem, and every mutation below invalidates
 * explicitly — the TTL is only the backstop for changes made by another instance.
 */
const CACHE_TTL_MS = 60_000;
const permissionCache = new Map<string, { codes: readonly string[]; expiresAt: number }>();

export function invalidatePermissionCache(roleId?: string): void {
  if (roleId) {
    permissionCache.delete(roleId);
    return;
  }
  permissionCache.clear();
}

export async function permissionsForRole(roleId: string): Promise<readonly string[]> {
  const cached = permissionCache.get(roleId);
  if (cached && cached.expiresAt > Date.now()) return cached.codes;

  const codes = await repository.permissionCodesForRole(roleId);
  permissionCache.set(roleId, { codes, expiresAt: Date.now() + CACHE_TTL_MS });
  return codes;
}

export function listRoles(): Promise<RoleRow[]> {
  return repository.listRoles();
}

export function listPermissions() {
  return repository.listPermissions();
}

export async function getRole(id: string): Promise<RoleWithPermissions> {
  const role = await repository.findRoleById(id);
  if (!role) throw AppError.notFound('Role not found');

  const permissions = await repository.permissionCodesForRole(id);
  return { ...role, permissions: permissions as PermissionCode[] };
}

export async function requireRoleById(id: string, exec?: Executor): Promise<RoleRow> {
  const role = await repository.findRoleById(id, exec);
  if (!role) {
    throw AppError.validation('Unknown role', {
      details: [{ field: 'roleId', issue: 'no role exists with this id' }],
    });
  }
  return role;
}

export async function createRole(
  input: CreateRoleInput,
  actor: Actor,
): Promise<RoleWithPermissions> {
  const existing = await repository.findRoleByCode(input.code);
  if (existing) throw AppError.conflict('A role with this code already exists');

  return withTransaction(async ({ tx }) => {
    const role = await repository.insertRole(
      {
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        isSystem: false,
      },
      tx,
    );

    await repository.replaceRolePermissions(role.id, input.permissions, tx);
    await auditService.record(
      {
        action: 'role.created',
        entityType: 'role',
        entityId: role.id,
        after: { ...role, permissions: input.permissions },
      },
      actor,
      tx,
    );

    return { ...role, permissions: input.permissions };
  });
}

export async function updateRole(
  id: string,
  patch: UpdateRoleInput,
  actor: Actor,
): Promise<RoleWithPermissions> {
  const before = await getRole(id);

  const updated = await withTransaction(async ({ tx }) => {
    const row = await repository.updateRole(
      id,
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      },
      tx,
    );
    if (!row) throw AppError.notFound('Role not found');

    await auditService.record(
      { action: 'role.updated', entityType: 'role', entityId: id, before, after: row },
      actor,
      tx,
    );
    return row;
  });

  return { ...updated, permissions: before.permissions };
}

/**
 * Replaces a role's grants.
 *
 * `super_admin` is immutable on purpose: it is the only role guaranteed to be
 * able to restore permissions, so allowing it to be narrowed creates a state
 * where nobody can grant anything back.
 */
export async function setRolePermissions(
  id: string,
  codes: PermissionCode[],
  actor: Actor,
): Promise<RoleWithPermissions> {
  const role = await repository.findRoleById(id);
  if (!role) throw AppError.notFound('Role not found');

  if (role.code === SUPER_ADMIN_ROLE_CODE) {
    throw new AppError(
      409,
      ErrorCode.SYSTEM_ROLE_IMMUTABLE,
      'The super administrator role always holds every permission and cannot be narrowed',
    );
  }

  const before = await repository.permissionCodesForRole(id);

  await withTransaction(async ({ tx }) => {
    await repository.replaceRolePermissions(id, codes, tx);
    await auditService.record(
      {
        action: 'role.permissions_changed',
        entityType: 'role',
        entityId: id,
        before: { permissions: before },
        after: { permissions: codes },
      },
      actor,
      tx,
    );
  });

  // Effective immediately for every instance's next cache miss, and for this
  // instance right now.
  invalidatePermissionCache(id);
  log.info('role permissions changed', { roleId: id, granted: codes.length });

  return { ...role, permissions: codes };
}

export async function deleteRole(id: string, actor: Actor): Promise<void> {
  const role = await repository.findRoleById(id);
  if (!role) throw AppError.notFound('Role not found');

  if (role.isSystem) {
    throw new AppError(409, ErrorCode.SYSTEM_ROLE_IMMUTABLE, 'Seeded roles cannot be deleted');
  }

  const holders = await repository.countUsersWithRole(id);
  if (holders > 0) {
    throw new AppError(
      409,
      ErrorCode.ROLE_IN_USE,
      `This role is still assigned to ${holders} ${holders === 1 ? 'account' : 'accounts'}`,
    );
  }

  await withTransaction(async ({ tx }) => {
    await auditService.record(
      { action: 'role.deleted', entityType: 'role', entityId: id, before: role },
      actor,
      tx,
    );
    await repository.deleteRole(id, tx);
  });

  invalidatePermissionCache(id);
}
