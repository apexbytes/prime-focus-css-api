import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import {
  identityProviders,
  ssoIdentities,
  ssoLoginRequests,
  type IdentityProviderRow,
  type NewIdentityProvider,
  type SsoIdentityRow,
  type SsoLoginRequestRow,
} from './sso.model.js';

// -- providers ---------------------------------------------------------------

export async function insertProvider(
  values: NewIdentityProvider,
  exec: Executor = db,
): Promise<IdentityProviderRow> {
  const [row] = await exec.insert(identityProviders).values(values).returning();
  if (!row) throw new Error('identity provider insert returned no row');
  return row;
}

export function listProviders(exec: Executor = db): Promise<IdentityProviderRow[]> {
  return exec.select().from(identityProviders).orderBy(asc(identityProviders.displayName));
}

/** Active providers only: what the sign-in screen is offered. */
export function listActiveProviders(exec: Executor = db): Promise<IdentityProviderRow[]> {
  return exec
    .select()
    .from(identityProviders)
    .where(eq(identityProviders.isActive, true))
    .orderBy(asc(identityProviders.displayName));
}

export async function findProviderById(
  id: string,
  exec: Executor = db,
): Promise<IdentityProviderRow | undefined> {
  const [row] = await exec
    .select()
    .from(identityProviders)
    .where(eq(identityProviders.id, id))
    .limit(1);
  return row;
}

export async function findProviderByCode(
  code: string,
  exec: Executor = db,
): Promise<IdentityProviderRow | undefined> {
  const [row] = await exec
    .select()
    .from(identityProviders)
    .where(eq(identityProviders.code, code))
    .limit(1);
  return row;
}

export async function updateProvider(
  id: string,
  patch: Partial<NewIdentityProvider>,
  exec: Executor = db,
): Promise<IdentityProviderRow | undefined> {
  const [row] = await exec
    .update(identityProviders)
    .set(patch)
    .where(eq(identityProviders.id, id))
    .returning();
  return row;
}

export async function deleteProvider(id: string, exec: Executor = db): Promise<boolean> {
  const rows = await exec
    .delete(identityProviders)
    .where(eq(identityProviders.id, id))
    .returning({ id: identityProviders.id });
  return rows.length > 0;
}

export async function countIdentitiesForProvider(id: string, exec: Executor = db): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(ssoIdentities)
    .where(eq(ssoIdentities.providerId, id));
  return row?.count ?? 0;
}

// -- login requests ----------------------------------------------------------

export async function insertLoginRequest(
  values: {
    providerId: string;
    stateHash: string;
    nonce: string;
    codeVerifier: string;
    redirectUri: string;
    returnPath: string | null;
    expiresAt: Date;
    ip: string | null;
    userAgent: string | null;
  },
  exec: Executor = db,
): Promise<SsoLoginRequestRow> {
  const [row] = await exec.insert(ssoLoginRequests).values(values).returning();
  if (!row) throw new Error('sso login request insert returned no row');
  return row;
}

/**
 * Claims a login request: finds it by `state` and marks it consumed in one
 * statement.
 *
 * The `consumed_at is null` predicate is the replay guard, and it has to be part
 * of the update rather than a check before it — two requests arriving with the
 * same captured `state` would otherwise both read an unconsumed row and both
 * proceed to exchange the code.
 */
export async function consumeLoginRequest(
  stateHash: string,
  exec: Executor = db,
): Promise<SsoLoginRequestRow | undefined> {
  const [row] = await exec
    .update(ssoLoginRequests)
    .set({ consumedAt: new Date() })
    .where(and(eq(ssoLoginRequests.stateHash, stateHash), isNull(ssoLoginRequests.consumedAt)))
    .returning();
  return row;
}

/** Whether a `state` exists at all, to tell a replay from something invented. */
export async function findLoginRequest(
  stateHash: string,
  exec: Executor = db,
): Promise<SsoLoginRequestRow | undefined> {
  const [row] = await exec
    .select()
    .from(ssoLoginRequests)
    .where(eq(ssoLoginRequests.stateHash, stateHash))
    .limit(1);
  return row;
}

/** Swept by the retention job: an expired request is spent, consumed or not. */
export async function deleteExpiredLoginRequests(
  before: Date,
  limit: number,
  exec: Executor = db,
): Promise<number> {
  const removed = await exec.execute(sql`
    delete from sso_login_requests
    where id in (
      select id from sso_login_requests
      where expires_at < ${before}
      order by expires_at
      limit ${limit}
    )
  `);

  return removed.rowCount ?? 0;
}

// -- identities --------------------------------------------------------------

export async function findIdentityBySubject(
  providerId: string,
  subject: string,
  exec: Executor = db,
): Promise<SsoIdentityRow | undefined> {
  const [row] = await exec
    .select()
    .from(ssoIdentities)
    .where(and(eq(ssoIdentities.providerId, providerId), eq(ssoIdentities.subject, subject)))
    .limit(1);
  return row;
}

export async function findIdentityForUser(
  providerId: string,
  userId: string,
  exec: Executor = db,
): Promise<SsoIdentityRow | undefined> {
  const [row] = await exec
    .select()
    .from(ssoIdentities)
    .where(and(eq(ssoIdentities.providerId, providerId), eq(ssoIdentities.userId, userId)))
    .limit(1);
  return row;
}

export async function insertIdentity(
  values: { providerId: string; userId: string; subject: string; email: string },
  exec: Executor = db,
): Promise<SsoIdentityRow> {
  const [row] = await exec
    .insert(ssoIdentities)
    .values({ ...values, lastLoginAt: new Date() })
    .returning();
  if (!row) throw new Error('sso identity insert returned no row');
  return row;
}

export async function recordIdentityLogin(
  id: string,
  email: string,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(ssoIdentities)
    .set({ email, lastLoginAt: new Date() })
    .where(eq(ssoIdentities.id, id));
}

export interface IdentityWithProvider extends SsoIdentityRow {
  providerCode: string;
  providerName: string;
}

export function listIdentitiesForUser(
  userId: string,
  exec: Executor = db,
): Promise<IdentityWithProvider[]> {
  return exec
    .select({
      id: ssoIdentities.id,
      providerId: ssoIdentities.providerId,
      userId: ssoIdentities.userId,
      subject: ssoIdentities.subject,
      email: ssoIdentities.email,
      lastLoginAt: ssoIdentities.lastLoginAt,
      createdAt: ssoIdentities.createdAt,
      updatedAt: ssoIdentities.updatedAt,
      providerCode: identityProviders.code,
      providerName: identityProviders.displayName,
    })
    .from(ssoIdentities)
    .innerJoin(identityProviders, eq(identityProviders.id, ssoIdentities.providerId))
    .where(eq(ssoIdentities.userId, userId))
    .orderBy(desc(ssoIdentities.createdAt));
}

export async function findIdentityById(
  id: string,
  exec: Executor = db,
): Promise<SsoIdentityRow | undefined> {
  const [row] = await exec.select().from(ssoIdentities).where(eq(ssoIdentities.id, id)).limit(1);
  return row;
}

export async function deleteIdentity(id: string, exec: Executor = db): Promise<boolean> {
  const rows = await exec
    .delete(ssoIdentities)
    .where(eq(ssoIdentities.id, id))
    .returning({ id: ssoIdentities.id });
  return rows.length > 0;
}

export async function countIdentitiesForUser(userId: string, exec: Executor = db): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(ssoIdentities)
    .where(eq(ssoIdentities.userId, userId));
  return row?.count ?? 0;
}
