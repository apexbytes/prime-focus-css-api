import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import {
  otpChallenges,
  trustedDevices,
  type OtpChallengeRow,
  type TrustedDeviceRow,
} from './mfa.model.js';

// -- OTP challenges -----------------------------------------------------------

export async function insertChallenge(
  values: typeof otpChallenges.$inferInsert,
  exec: Executor = db,
): Promise<OtpChallengeRow> {
  const [row] = await exec.insert(otpChallenges).values(values).returning();
  if (!row) throw new Error('otp challenge insert returned no row');
  return row;
}

export async function findChallengeById(
  id: string,
  exec: Executor = db,
): Promise<OtpChallengeRow | undefined> {
  const [row] = await exec.select().from(otpChallenges).where(eq(otpChallenges.id, id)).limit(1);
  return row;
}

/** Only one live challenge per user: issuing a new code kills the previous one. */
export async function deleteLiveChallenges(userId: string, exec: Executor = db): Promise<void> {
  await exec
    .delete(otpChallenges)
    .where(and(eq(otpChallenges.userId, userId), isNull(otpChallenges.consumedAt)));
}

export async function incrementAttempts(id: string, exec: Executor = db): Promise<number> {
  const [row] = await exec
    .update(otpChallenges)
    // Incremented in SQL rather than read-modify-write, so two concurrent
    // guesses cannot both see the same starting count.
    .set({ attempts: sql`${otpChallenges.attempts} + 1` })
    .where(eq(otpChallenges.id, id))
    .returning({ attempts: otpChallenges.attempts });

  return row?.attempts ?? 0;
}

export async function markChallengeConsumed(id: string, exec: Executor = db): Promise<void> {
  await exec.update(otpChallenges).set({ consumedAt: new Date() }).where(eq(otpChallenges.id, id));
}

export async function replaceChallengeCode(
  id: string,
  codeHash: string,
  sendCount: number,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(otpChallenges)
    .set({ codeHash, sendCount, lastSentAt: new Date() })
    .where(eq(otpChallenges.id, id));
}

export async function purgeExpiredChallenges(exec: Executor = db): Promise<void> {
  await exec.delete(otpChallenges).where(lt(otpChallenges.expiresAt, new Date()));
}

// -- trusted devices ----------------------------------------------------------

export async function insertDevice(
  values: typeof trustedDevices.$inferInsert,
  exec: Executor = db,
): Promise<TrustedDeviceRow> {
  const [row] = await exec.insert(trustedDevices).values(values).returning();
  if (!row) throw new Error('trusted device insert returned no row');
  return row;
}

export async function findLiveDevice(
  userId: string,
  tokenHash: string,
  exec: Executor = db,
): Promise<TrustedDeviceRow | undefined> {
  const [row] = await exec
    .select()
    .from(trustedDevices)
    .where(
      and(
        eq(trustedDevices.userId, userId),
        eq(trustedDevices.tokenHash, tokenHash),
        isNull(trustedDevices.revokedAt),
        gt(trustedDevices.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return row;
}

export function listLiveDevices(userId: string, exec: Executor = db): Promise<TrustedDeviceRow[]> {
  return exec
    .select()
    .from(trustedDevices)
    .where(
      and(
        eq(trustedDevices.userId, userId),
        isNull(trustedDevices.revokedAt),
        gt(trustedDevices.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(trustedDevices.lastSeenAt));
}

export async function touchDevice(
  id: string,
  ip: string | null,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(trustedDevices)
    .set({ lastSeenAt: new Date(), ...(ip ? { ip } : {}) })
    .where(eq(trustedDevices.id, id));
}

export async function revokeDevice(
  userId: string,
  id: string,
  exec: Executor = db,
): Promise<TrustedDeviceRow | undefined> {
  const [row] = await exec
    .update(trustedDevices)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(trustedDevices.id, id),
        eq(trustedDevices.userId, userId),
        isNull(trustedDevices.revokedAt),
      ),
    )
    .returning();

  return row;
}

/** Used when a password changes or an account is suspended. */
export async function revokeAllDevices(userId: string, exec: Executor = db): Promise<number> {
  const rows = await exec
    .update(trustedDevices)
    .set({ revokedAt: new Date() })
    .where(and(eq(trustedDevices.userId, userId), isNull(trustedDevices.revokedAt)))
    .returning({ id: trustedDevices.id });

  return rows.length;
}

export async function purgeExpiredDevices(exec: Executor = db): Promise<void> {
  await exec.delete(trustedDevices).where(lt(trustedDevices.expiresAt, new Date()));
}
