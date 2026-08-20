import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Express } from 'express';
import { db } from '../../src/db/client.js';
import { hashPassword } from '../../src/common/utils/crypto.js';
import { roles } from '../../src/modules/role/role.model.js';
import { users } from '../../src/modules/user/user.model.js';
import { lastEmailTo } from '../../src/lib/resend/index.js';

export const STRONG_PASSWORD = 'correct-horse-battery-staple-42';

export async function roleIdFor(code: string): Promise<string> {
  const [role] = await db.select().from(roles).where(eq(roles.code, code)).limit(1);
  if (!role) throw new Error(`role ${code} not seeded`);
  return role.id;
}

/** Creates an active account directly, bypassing the invitation flow. */
export async function createActiveUser(input: {
  email: string;
  roleCode: string;
  fullName?: string;
  password?: string;
}): Promise<{ id: string; email: string; password: string }> {
  const password = input.password ?? STRONG_PASSWORD;
  const [row] = await db
    .insert(users)
    .values({
      email: input.email.toLowerCase(),
      fullName: input.fullName ?? 'Test Person',
      roleId: await roleIdFor(input.roleCode),
      status: 'active',
      passwordHash: await hashPassword(password),
      passwordChangedAt: new Date(),
    })
    .returning();

  if (!row) throw new Error('failed to create test user');
  return { id: row.id, email: row.email, password };
}

/** Pulls the login code out of the email that the log transport captured. */
export function otpCodeFor(email: string): string {
  const message = lastEmailTo(email.toLowerCase());
  if (!message) throw new Error(`no email captured for ${email}`);

  const match = /Your login code is (\d+)/.exec(message.text);
  if (!match?.[1]) throw new Error(`no login code in email to ${email}`);
  return match[1];
}

export function invitationTokenFor(email: string): string {
  const message = lastEmailTo(email.toLowerCase());
  if (!message) throw new Error(`no email captured for ${email}`);

  const match = /accept-invitation\?token=([\w.-]+)/.exec(message.text);
  if (!match?.[1]) throw new Error(`no invitation token in email to ${email}`);
  return match[1];
}

export function resetTokenFor(email: string): string {
  const message = lastEmailTo(email.toLowerCase());
  if (!message) throw new Error(`no email captured for ${email}`);

  const match = /reset-password\?token=([\w.-]+)/.exec(message.text);
  if (!match?.[1]) throw new Error(`no reset token in email to ${email}`);
  return match[1];
}

export interface SignedIn {
  accessToken: string;
  refreshToken: string;
  userId: string;
  deviceToken?: string;
}

/** Full password + emailed OTP login, as a real client would do it. */
export async function signIn(
  app: Express,
  email: string,
  password = STRONG_PASSWORD,
  options: { trustDevice?: boolean } = {},
): Promise<SignedIn> {
  const login = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (login.status !== 200) {
    throw new Error(`login failed (${login.status}): ${JSON.stringify(login.body)}`);
  }

  if (login.body.data.status === 'authenticated') {
    return {
      accessToken: login.body.data.tokens.accessToken,
      refreshToken: login.body.data.tokens.refreshToken,
      userId: login.body.data.user.id,
    };
  }

  const verified = await request(app)
    .post('/api/v1/auth/otp/verify')
    .send({
      challengeId: login.body.data.challengeId,
      code: otpCodeFor(email),
      trustDevice: options.trustDevice ?? false,
    });

  if (verified.status !== 200) {
    throw new Error(`otp verify failed (${verified.status}): ${JSON.stringify(verified.body)}`);
  }

  return {
    accessToken: verified.body.data.tokens.accessToken,
    refreshToken: verified.body.data.tokens.refreshToken,
    userId: verified.body.data.user.id,
    deviceToken: verified.body.data.deviceToken,
  };
}

export function bearer(token: string): [string, string] {
  return ['authorization', `Bearer ${token}`];
}
