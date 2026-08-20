import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { users } from '../user/user.model.js';
import {
  permissions,
  rolePermissions,
  roles,
  type NewRole,
  type PermissionRow,
  type RoleRow,
} from './role.model.js';

export function listRoles(exec: Executor = db): Promise<RoleRow[]> {
  return exec.select().from(roles).orderBy(asc(roles.name));
}

export async function findRoleById(id: string, exec: Executor = db): Promise<RoleRow | undefined> {
  const [row] = await exec.select().from(roles).where(eq(roles.id, id)).limit(1);
  return row;
}

export async function findRoleByCode(
  code: string,
  exec: Executor = db,
): Promise<RoleRow | undefined> {
  const [row] = await exec.select().from(roles).where(eq(roles.code, code)).limit(1);
  return row;
}

export async function insertRole(role: NewRole, exec: Executor = db): Promise<RoleRow> {
  const [row] = await exec.insert(roles).values(role).returning();
  if (!row) throw new Error('insertRole returned no row');
  return row;
}

export async function updateRole(
  id: string,
  patch: Partial<Pick<RoleRow, 'name' | 'description'>>,
  exec: Executor = db,
): Promise<RoleRow | undefined> {
  const [row] = await exec.update(roles).set(patch).where(eq(roles.id, id)).returning();
  return row;
}

export async function deleteRole(id: string, exec: Executor = db): Promise<void> {
  await exec.delete(roles).where(eq(roles.id, id));
}

export function listPermissions(exec: Executor = db): Promise<PermissionRow[]> {
  return exec.select().from(permissions).orderBy(asc(permissions.category), asc(permissions.code));
}

/** Permission codes granted to one role. */
export async function permissionCodesForRole(
  roleId: string,
  exec: Executor = db,
): Promise<string[]> {
  const rows = await exec
    .select({ code: permissions.code })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(rolePermissions.roleId, roleId));

  return rows.map((row) => row.code);
}

/** Replaces a role's grants wholesale. Caller supplies the transaction. */
export async function replaceRolePermissions(
  roleId: string,
  codes: string[],
  exec: Executor = db,
): Promise<void> {
  await exec.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  if (codes.length === 0) return;

  const rows = await exec
    .select({ id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, codes));

  await exec
    .insert(rolePermissions)
    .values(rows.map((row) => ({ roleId, permissionId: row.id })))
    .onConflictDoNothing();
}

export async function countUsersWithRole(roleId: string, exec: Executor = db): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.roleId, roleId));

  return row?.count ?? 0;
}
