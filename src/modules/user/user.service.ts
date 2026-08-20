import { AppError, ErrorCode } from '../../common/errors/index.js';
import { isUserActor, type Actor } from '../../common/types/actor.js';
import { SUPER_ADMIN_ROLE_CODE } from '../../common/types/permissions.js';
import { withTransaction, type Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as auditService from '../audit/audit.service.js';
// Cyclic with auth.service by design: suspension has to revoke sessions, and
// login has to read users. Both sides export hoisted function declarations and
// touch each other only inside function bodies, so the cycle resolves safely.
import * as authService from '../auth/auth.service.js';
import * as roleService from '../role/role.service.js';
import * as repository from './user.repository.js';
import type { ListUsersFilter, PublicUser, UserStatus, UserWithRole } from './user.types.js';

const log = createModuleLogger('user');

/** Strips the password hash and internal counters before anything leaves the API. */
export function toPublicUser(user: UserWithRole): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    status: user.status,
    roleId: user.roleId,
    roleCode: user.roleCode,
    roleName: user.roleName,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

export function findById(id: string, exec?: Executor): Promise<UserWithRole | undefined> {
  return repository.findById(id, exec);
}

export function findByEmail(email: string, exec?: Executor): Promise<UserWithRole | undefined> {
  return repository.findByEmail(normaliseEmail(email), exec);
}

/** Emails are compared case-insensitively by storing them lower-cased. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function requireById(id: string): Promise<UserWithRole> {
  const user = await repository.findById(id);
  if (!user) throw AppError.notFound('User not found');
  return user;
}

export async function listUsers(filter: ListUsersFilter): Promise<UserWithRole[]> {
  return repository.list(filter);
}

export async function updateProfile(
  id: string,
  patch: { fullName?: string | undefined; phone?: string | null | undefined },
  actor: Actor,
): Promise<PublicUser> {
  const before = await requireById(id);

  const updated = await withTransaction(async ({ tx }) => {
    const row = await repository.update(
      id,
      {
        ...(patch.fullName !== undefined ? { fullName: patch.fullName } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      },
      tx,
    );
    if (!row) throw AppError.notFound('User not found');

    await auditService.record(
      {
        action: 'user.profile_updated',
        entityType: 'user',
        entityId: id,
        before: { fullName: before.fullName, phone: before.phone },
        after: { fullName: row.fullName, phone: row.phone },
      },
      actor,
      tx,
    );
    return row;
  });

  return toPublicUser({ ...before, ...updated });
}

export async function changeRole(id: string, roleId: string, actor: Actor): Promise<PublicUser> {
  const user = await requireById(id);
  if (user.roleId === roleId) return toPublicUser(user);

  const role = await roleService.requireRoleById(roleId);

  // Demoting the last active super administrator would leave nobody able to
  // grant the role back.
  if (user.roleCode === SUPER_ADMIN_ROLE_CODE && role.code !== SUPER_ADMIN_ROLE_CODE) {
    await assertNotLastSuperAdmin(user);
  }

  const updated = await withTransaction(async ({ tx }) => {
    const row = await repository.update(id, { roleId }, tx);
    if (!row) throw AppError.notFound('User not found');

    await auditService.record(
      {
        action: 'user.role_changed',
        entityType: 'user',
        entityId: id,
        before: { roleId: user.roleId, roleCode: user.roleCode },
        after: { roleId: role.id, roleCode: role.code },
      },
      actor,
      tx,
    );
    return row;
  });

  log.info('user role changed', { userId: id, from: user.roleCode, to: role.code });
  return toPublicUser({ ...user, ...updated, roleCode: role.code, roleName: role.name });
}

/** Suspending an account also revokes its sessions and trusted devices. */
export async function changeStatus(
  id: string,
  status: Extract<UserStatus, 'active' | 'suspended'>,
  actor: Actor,
): Promise<PublicUser> {
  const user = await requireById(id);

  if (isUserActor(actor) && actor.id === id) {
    throw new AppError(
      409,
      ErrorCode.SELF_ACTION_FORBIDDEN,
      'You cannot change your own account status',
    );
  }

  if (status === 'suspended' && user.roleCode === SUPER_ADMIN_ROLE_CODE) {
    await assertNotLastSuperAdmin(user);
  }

  if (user.status === status) return toPublicUser(user);

  const updated = await withTransaction(async ({ tx }) => {
    const row = await repository.update(id, { status }, tx);
    if (!row) throw AppError.notFound('User not found');

    if (status === 'suspended') {
      await authService.revokeAccess(id, tx);
    }

    await auditService.record(
      {
        action: status === 'suspended' ? 'user.suspended' : 'user.reactivated',
        entityType: 'user',
        entityId: id,
        before: { status: user.status },
        after: { status },
      },
      actor,
      tx,
    );
    return row;
  });

  log.info('user status changed', { userId: id, status });
  return toPublicUser({ ...user, ...updated });
}

async function assertNotLastSuperAdmin(user: UserWithRole): Promise<void> {
  const remaining = await repository.countActiveByRoleCode(SUPER_ADMIN_ROLE_CODE);
  if (remaining <= 1) {
    throw new AppError(
      409,
      ErrorCode.LAST_SUPER_ADMIN,
      'This is the only active super administrator; promote another account first',
      { context: { userId: user.id } },
    );
  }
}

// -- called by the auth and invitation modules --------------------------------

export function createInvited(
  input: { email: string; fullName: string; roleId: string },
  exec: Executor,
) {
  return repository.insert(
    {
      email: normaliseEmail(input.email),
      fullName: input.fullName,
      roleId: input.roleId,
      status: 'invited',
    },
    exec,
  );
}

export function activate(
  id: string,
  passwordHash: string,
  patch: { fullName?: string | undefined },
  exec: Executor,
) {
  return repository.update(
    id,
    {
      passwordHash,
      status: 'active',
      passwordChangedAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
      ...(patch.fullName ? { fullName: patch.fullName } : {}),
    },
    exec,
  );
}

export function setPassword(id: string, passwordHash: string, exec: Executor) {
  return repository.update(
    id,
    { passwordHash, passwordChangedAt: new Date(), failedLoginAttempts: 0, lockedUntil: null },
    exec,
  );
}

export const recordFailedLogin = repository.recordFailedLogin;
export const recordSuccessfulLogin = repository.recordSuccessfulLogin;
