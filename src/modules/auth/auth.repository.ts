import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import {
  loginAttempts,
  passwordResetTokens,
  sessions,
  type LoginOutcome,
  type PasswordResetTokenRow,
  type SessionRow,
} from './auth.model.js';

// -- sessions -----------------------------------------------------------------

export async function insertSession(
  values: typeof sessions.$inferInsert,
  exec: Executor = db,
): Promise<SessionRow> {
  const [row] = await exec.insert(sessions).values(values).returning();
  if (!row) throw new Error('session insert returned no row');
  return row;
}

export async function findSessionByTokenHash(
  tokenHash: string,
  exec: Executor = db,
): Promise<SessionRow | undefined> {
  const [row] = await exec
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  return row;
}

export async function findSessionById(
  id: string,
  exec: Executor = db,
): Promise<SessionRow | undefined> {
  const [row] = await exec.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return row;
}

export function listLiveSessions(userId: string, exec: Executor = db): Promise<SessionRow[]> {
  return exec
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(sessions.lastUsedAt));
}

export async function revokeSession(
  id: string,
  reason: string,
  exec: Executor = db,
): Promise<SessionRow | undefined> {
  const [row] = await exec
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
    .returning();

  return row;
}

/**
 * Kills every session descended from one login. Used on refresh-token reuse,
 * where the only explanations are theft or a replay.
 */
export async function revokeFamily(
  familyId: string,
  reason: string,
  exec: Executor = db,
): Promise<number> {
  const rows = await exec
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  return rows.length;
}

export async function revokeAllForUser(
  userId: string,
  reason: string,
  exec: Executor = db,
): Promise<number> {
  const rows = await exec
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  return rows.length;
}

export async function markRotated(
  oldSessionId: string,
  newSessionId: string,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: 'rotated', replacedBySessionId: newSessionId })
    .where(eq(sessions.id, oldSessionId));
}

export async function touchSession(id: string, exec: Executor = db): Promise<void> {
  await exec.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, id));
}

// -- password reset -----------------------------------------------------------

export async function insertPasswordReset(
  values: typeof passwordResetTokens.$inferInsert,
  exec: Executor = db,
): Promise<void> {
  await exec.insert(passwordResetTokens).values(values);
}

export async function findPasswordReset(
  tokenHash: string,
  exec: Executor = db,
): Promise<PasswordResetTokenRow | undefined> {
  const [row] = await exec
    .select()
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1);

  return row;
}

export async function markPasswordResetUsed(id: string, exec: Executor = db): Promise<void> {
  await exec
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.id, id));
}

/** A new reset request invalidates any outstanding one. */
export async function consumeOutstandingResets(userId: string, exec: Executor = db): Promise<void> {
  await exec
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
}

// -- login attempts -----------------------------------------------------------

export async function recordAttempt(
  values: {
    email: string;
    userId?: string | null;
    outcome: LoginOutcome;
    ip?: string | null;
    userAgent?: string | null;
  },
  exec: Executor = db,
): Promise<void> {
  await exec.insert(loginAttempts).values({
    email: values.email,
    userId: values.userId ?? null,
    outcome: values.outcome,
    ip: values.ip ?? null,
    userAgent: values.userAgent ?? null,
  });
}
