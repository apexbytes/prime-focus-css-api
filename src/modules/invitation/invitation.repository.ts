import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { roles } from '../role/role.model.js';
import { users } from '../user/user.model.js';
import { invitations, type InvitationRow } from './invitation.model.js';

const listColumns = {
  id: invitations.id,
  userId: invitations.userId,
  email: invitations.email,
  roleId: invitations.roleId,
  tokenHash: invitations.tokenHash,
  invitedByUserId: invitations.invitedByUserId,
  expiresAt: invitations.expiresAt,
  acceptedAt: invitations.acceptedAt,
  revokedAt: invitations.revokedAt,
  lastSentAt: invitations.lastSentAt,
  sendCount: invitations.sendCount,
  createdAt: invitations.createdAt,
  updatedAt: invitations.updatedAt,
  roleName: roles.name,
  fullName: users.fullName,
};

export type InvitationWithDetails = InvitationRow & { roleName: string; fullName: string };

export async function insert(
  values: typeof invitations.$inferInsert,
  exec: Executor = db,
): Promise<InvitationRow> {
  const [row] = await exec.insert(invitations).values(values).returning();
  if (!row) throw new Error('invitation insert returned no row');
  return row;
}

export async function findByTokenHash(
  tokenHash: string,
  exec: Executor = db,
): Promise<InvitationWithDetails | undefined> {
  const [row] = await exec
    .select(listColumns)
    .from(invitations)
    .innerJoin(roles, eq(roles.id, invitations.roleId))
    .innerJoin(users, eq(users.id, invitations.userId))
    .where(eq(invitations.tokenHash, tokenHash))
    .limit(1);

  return row;
}

export async function findById(
  id: string,
  exec: Executor = db,
): Promise<InvitationWithDetails | undefined> {
  const [row] = await exec
    .select(listColumns)
    .from(invitations)
    .innerJoin(roles, eq(roles.id, invitations.roleId))
    .innerJoin(users, eq(users.id, invitations.userId))
    .where(eq(invitations.id, id))
    .limit(1);

  return row;
}

export function list(exec: Executor = db): Promise<InvitationWithDetails[]> {
  return exec
    .select(listColumns)
    .from(invitations)
    .innerJoin(roles, eq(roles.id, invitations.roleId))
    .innerJoin(users, eq(users.id, invitations.userId))
    .orderBy(desc(invitations.createdAt));
}

/** The live invitation for a user, if any. */
export async function findLiveForUser(
  userId: string,
  exec: Executor = db,
): Promise<InvitationRow | undefined> {
  const [row] = await exec
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.userId, userId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .orderBy(desc(invitations.createdAt))
    .limit(1);

  return row;
}

export async function markAccepted(id: string, exec: Executor = db): Promise<void> {
  await exec.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, id));
}

export async function revoke(id: string, exec: Executor = db): Promise<InvitationRow | undefined> {
  const [row] = await exec
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(invitations.id, id), isNull(invitations.revokedAt), isNull(invitations.acceptedAt)),
    )
    .returning();

  return row;
}

export async function refreshToken(
  id: string,
  tokenHash: string,
  expiresAt: Date,
  sendCount: number,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(invitations)
    .set({ tokenHash, expiresAt, sendCount, lastSentAt: new Date() })
    .where(eq(invitations.id, id));
}

export async function deleteById(id: string, exec: Executor = db): Promise<void> {
  await exec.delete(invitations).where(eq(invitations.id, id));
}
