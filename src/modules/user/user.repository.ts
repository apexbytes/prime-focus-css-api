import { and, asc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { roles } from '../role/role.model.js';
import { tickets, type TicketStatus } from '../ticket/ticket.model.js';
import { users, type NewUser, type UserRow } from './user.model.js';
import type { ListUsersFilter, UserWithRole } from './user.types.js';

const withRoleColumns = {
  id: users.id,
  email: users.email,
  fullName: users.fullName,
  phone: users.phone,
  roleId: users.roleId,
  status: users.status,
  passwordHash: users.passwordHash,
  passwordChangedAt: users.passwordChangedAt,
  lastLoginAt: users.lastLoginAt,
  failedLoginAttempts: users.failedLoginAttempts,
  lockedUntil: users.lockedUntil,
  availability: users.availability,
  maxOpenTickets: users.maxOpenTickets,
  deletedAt: users.deletedAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
  roleCode: roles.code,
  roleName: roles.name,
};

export async function findById(id: string, exec: Executor = db): Promise<UserWithRole | undefined> {
  const [row] = await exec
    .select(withRoleColumns)
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);

  return row;
}

/** Email is stored lower-cased; callers must normalise before lookup. */
export async function findByEmail(
  email: string,
  exec: Executor = db,
): Promise<UserWithRole | undefined> {
  const [row] = await exec
    .select(withRoleColumns)
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);

  return row;
}

export async function insert(user: NewUser, exec: Executor = db): Promise<UserRow> {
  const [row] = await exec.insert(users).values(user).returning();
  if (!row) throw new Error('user insert returned no row');
  return row;
}

export async function update(
  id: string,
  patch: Partial<UserRow>,
  exec: Executor = db,
): Promise<UserRow | undefined> {
  const [row] = await exec.update(users).set(patch).where(eq(users.id, id)).returning();
  return row;
}

export async function list(filter: ListUsersFilter, exec: Executor = db): Promise<UserWithRole[]> {
  const conditions = [
    isNull(users.deletedAt),
    filter.status ? eq(users.status, filter.status) : undefined,
    filter.roleId ? eq(users.roleId, filter.roleId) : undefined,
    filter.search
      ? or(ilike(users.fullName, `%${filter.search}%`), ilike(users.email, `%${filter.search}%`))
      : undefined,
    // Keyset pagination on email, which is unique and has a stable order.
    filter.cursor ? gt(users.email, filter.cursor) : undefined,
  ].filter((condition) => condition !== undefined);

  return exec
    .select(withRoleColumns)
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(...conditions))
    .orderBy(asc(users.email))
    .limit(filter.limit);
}

/** Used to stop the last super administrator locking everyone out. */
export async function countActiveByRoleCode(code: string, exec: Executor = db): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(roles.code, code), eq(users.status, 'active'), isNull(users.deletedAt)));

  return row?.count ?? 0;
}

/**
 * Work that would be stranded by deleting this account. Deleted rows are already
 * excluded from routing, so this counts what is *already* on their desk.
 *
 * The statuses come from the caller because the boundary rules let a repository
 * reach another module's tables but not its constants, and `OPEN_STATUSES` is
 * the ticket module's to define.
 */
export async function countOpenAssignedTickets(
  id: string,
  openStatuses: readonly TicketStatus[],
  exec: Executor = db,
): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(tickets)
    .where(
      and(
        eq(tickets.assignedToUserId, id),
        inArray(tickets.status, [...openStatuses]),
        isNull(tickets.deletedAt),
      ),
    );

  return row?.count ?? 0;
}

/**
 * Soft delete. The row stays so the audit trail and every historical
 * `assigned_to_user_id` keep resolving to a name; every read in this repository
 * already filters on `deletedAt`.
 *
 * The email is tombstoned rather than kept, because it is unique across the
 * table: leaving it in place would make the address permanently un-invitable
 * with no way back through the API. The original is preserved in the audit row.
 */
export async function softDelete(id: string, exec: Executor = db): Promise<UserRow | undefined> {
  const [row] = await exec
    .update(users)
    .set({
      deletedAt: new Date(),
      email: `deleted+${id}@deleted.invalid`,
      availability: 'offline',
    })
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .returning();

  return row;
}

export async function recordFailedLogin(
  id: string,
  attempts: number,
  lockedUntil: Date | null,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(users)
    .set({ failedLoginAttempts: attempts, lockedUntil })
    .where(eq(users.id, id));
}

export async function recordSuccessfulLogin(id: string, exec: Executor = db): Promise<void> {
  await exec
    .update(users)
    .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, id));
}
