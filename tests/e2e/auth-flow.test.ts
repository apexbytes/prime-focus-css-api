import request from 'supertest';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { closeDatabase, db } from '../../src/db/client.js';
import { users } from '../../src/modules/user/user.model.js';
import { sessions } from '../../src/modules/auth/auth.model.js';
import { resetDatabase } from '../helpers/db.js';
import {
  STRONG_PASSWORD,
  bearer,
  createActiveUser,
  otpCodeFor,
  signIn,
} from '../helpers/identity.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const app = createApp();

const AGENT_EMAIL = 'agent@primefocus.co.zw';

describe.runIf(enabled)('authentication', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    await createActiveUser({ email: AGENT_EMAIL, roleCode: 'tier1_agent', fullName: 'Tarisai M' });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('POST /auth/login', () => {
    it('requires an emailed code after a correct password', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: AGENT_EMAIL, password: STRONG_PASSWORD });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('otp_required');
      expect(response.body.data.challengeId).toBeTypeOf('string');
      expect(response.body.data.codeLength).toBe(6);
      // The code itself must never come back in the response.
      expect(JSON.stringify(response.body)).not.toContain(otpCodeFor(AGENT_EMAIL));
    });

    it('gives the same answer for a wrong password and an unknown address', async () => {
      const wrongPassword = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: AGENT_EMAIL, password: 'not-the-right-password' });

      const unknownEmail = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@primefocus.co.zw', password: 'not-the-right-password' });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      // Identical body: this endpoint must not confirm whether an account exists.
      expect(unknownEmail.body.error).toEqual(wrongPassword.body.error);
      expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('locks the account after the configured number of failures', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: AGENT_EMAIL, password: `wrong-${attempt}` });
      }

      const locked = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: AGENT_EMAIL, password: STRONG_PASSWORD });

      expect(locked.status).toBe(403);
      expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
      // Revealed only because the password was correct.
      expect(locked.body.error.details[0].field).toBe('lockedUntil');
    });

    it('does not reveal a lockout to someone guessing passwords', async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: AGENT_EMAIL, password: `wrong-${attempt}` });
      }

      const stillGuessing = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: AGENT_EMAIL, password: 'another-wrong-guess' });

      expect(stillGuessing.status).toBe(401);
      expect(stillGuessing.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('refuses a suspended account', async () => {
      await db.update(users).set({ status: 'suspended' }).where(eq(users.email, AGENT_EMAIL));

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: AGENT_EMAIL, password: STRONG_PASSWORD });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('tells an invited user to use their invitation', async () => {
      await db
        .update(users)
        .set({ status: 'invited', passwordHash: null })
        .where(eq(users.email, AGENT_EMAIL));

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: AGENT_EMAIL, password: STRONG_PASSWORD });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ACCOUNT_NOT_ACTIVATED');
    });
  });

  describe('POST /auth/otp/verify', () => {
    async function startLogin(): Promise<string> {
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: AGENT_EMAIL, password: STRONG_PASSWORD });
      return login.body.data.challengeId as string;
    }

    it('issues tokens for the correct code', async () => {
      const challengeId = await startLogin();

      const response = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId, code: otpCodeFor(AGENT_EMAIL) });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('authenticated');
      expect(response.body.data.tokens.accessToken).toBeTypeOf('string');
      expect(response.body.data.tokens.tokenType).toBe('Bearer');
      // No device token unless it was asked for.
      expect(response.body.data.deviceToken).toBeUndefined();
      // The password hash must never surface in a response.
      expect(JSON.stringify(response.body)).not.toContain('argon2');
    });

    it('rejects a wrong code and counts down the remaining attempts', async () => {
      const challengeId = await startLogin();

      const first = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId, code: '000000' });

      expect(first.status).toBe(401);
      expect(first.body.error.code).toBe('OTP_INVALID');
      expect(first.body.error.details[0].issue).toContain('attempts remaining');
    });

    it('stops accepting guesses after the attempt limit', async () => {
      const challengeId = await startLogin();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app).post('/api/v1/auth/otp/verify').send({ challengeId, code: '000000' });
      }

      // Even the correct code is refused once the challenge is burnt.
      const response = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId, code: otpCodeFor(AGENT_EMAIL) });

      expect(response.status).toBe(429);
      expect(response.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
    });

    it('cannot reuse a consumed challenge', async () => {
      const challengeId = await startLogin();
      const code = otpCodeFor(AGENT_EMAIL);

      await request(app).post('/api/v1/auth/otp/verify').send({ challengeId, code }).expect(200);
      const replay = await request(app).post('/api/v1/auth/otp/verify').send({ challengeId, code });

      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('OTP_INVALID');
    });

    it('invalidates the previous code when a second login starts', async () => {
      await startLogin();
      const firstCode = otpCodeFor(AGENT_EMAIL);

      const secondChallenge = await startLogin();
      const secondCode = otpCodeFor(AGENT_EMAIL);
      expect(secondCode).not.toBe(firstCode);

      const stale = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId: secondChallenge, code: firstCode });

      expect(stale.status).toBe(401);
    });
  });

  describe('trusted devices', () => {
    it('skips the code on a device that was trusted', async () => {
      const session = await signIn(app, AGENT_EMAIL, STRONG_PASSWORD, { trustDevice: true });
      expect(session.deviceToken).toBeTypeOf('string');

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: AGENT_EMAIL, password: STRONG_PASSWORD, deviceToken: session.deviceToken });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('authenticated');
    });

    it('still demands the password on a trusted device', async () => {
      const session = await signIn(app, AGENT_EMAIL, STRONG_PASSWORD, { trustDevice: true });

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: AGENT_EMAIL, password: 'wrong', deviceToken: session.deviceToken });

      expect(response.status).toBe(401);
    });

    it('falls back to a code once the device is revoked', async () => {
      const session = await signIn(app, AGENT_EMAIL, STRONG_PASSWORD, { trustDevice: true });

      const devices = await request(app)
        .get('/api/v1/auth/devices')
        .set(...bearer(session.accessToken));
      expect(devices.body.data).toHaveLength(1);
      expect(devices.body.data[0].label).toBeTypeOf('string');

      await request(app)
        .delete(`/api/v1/auth/devices/${devices.body.data[0].id}`)
        .set(...bearer(session.accessToken))
        .expect(204);

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: AGENT_EMAIL, password: STRONG_PASSWORD, deviceToken: session.deviceToken });

      expect(response.body.data.status).toBe('otp_required');
    });

    it('ignores a device token belonging to someone else', async () => {
      const other = await createActiveUser({
        email: 'other@primefocus.co.zw',
        roleCode: 'tier1_agent',
      });
      const otherSession = await signIn(app, other.email, other.password, { trustDevice: true });

      const response = await request(app).post('/api/v1/auth/login').send({
        email: AGENT_EMAIL,
        password: STRONG_PASSWORD,
        deviceToken: otherSession.deviceToken,
      });

      expect(response.body.data.status).toBe('otp_required');
    });
  });

  describe('refresh rotation', () => {
    it('rotates the refresh token on use', async () => {
      const session = await signIn(app, AGENT_EMAIL);

      const refreshed = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken });

      expect(refreshed.status).toBe(200);
      expect(refreshed.body.data.tokens.refreshToken).not.toBe(session.refreshToken);
    });

    it('revokes the whole family when an old token is replayed', async () => {
      const session = await signIn(app, AGENT_EMAIL);

      const rotated = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken });
      const currentToken = rotated.body.data.tokens.refreshToken as string;

      // The thief's replay of the already-rotated token.
      const replay = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken });
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('SESSION_REVOKED');

      // The legitimate holder's token is killed too — that is the point.
      const afterBreach = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: currentToken });
      expect(afterBreach.status).toBe(401);

      const rows = await db.select().from(sessions);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    });

    it('refuses an unknown refresh token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'x'.repeat(43) });

      expect(response.status).toBe(401);
    });
  });

  describe('access tokens', () => {
    it('identifies the caller on /auth/me', async () => {
      const session = await signIn(app, AGENT_EMAIL);

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(session.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data.email).toBe(AGENT_EMAIL);
      expect(response.body.data.roleCode).toBe('tier1_agent');
      expect(response.body.data.permissions).toContain('ticket:read');
      expect(response.body.data.permissions).not.toContain('user:invite');
    });

    it('rejects a missing or malformed Authorization header', async () => {
      await request(app).get('/api/v1/auth/me').expect(401);
      await request(app).get('/api/v1/auth/me').set('authorization', 'Basic abc').expect(401);
      await request(app).get('/api/v1/auth/me').set('authorization', 'Bearer nonsense').expect(401);
    });

    it('stops working the moment the account is suspended', async () => {
      const session = await signIn(app, AGENT_EMAIL);
      await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(session.accessToken))
        .expect(200);

      await db.update(users).set({ status: 'suspended' }).where(eq(users.email, AGENT_EMAIL));

      // Not at the end of the token's 15-minute life — immediately.
      const response = await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(session.accessToken));
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('stops working after logout', async () => {
      const session = await signIn(app, AGENT_EMAIL);

      await request(app)
        .post('/api/v1/auth/logout')
        .set(...bearer(session.accessToken))
        .expect(204);

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(session.accessToken));
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('SESSION_REVOKED');
    });
  });

  describe('sessions', () => {
    it('lists live sessions and marks the current one', async () => {
      const first = await signIn(app, AGENT_EMAIL);
      await signIn(app, AGENT_EMAIL);

      const response = await request(app)
        .get('/api/v1/auth/sessions')
        .set(...bearer(first.accessToken));

      expect(response.body.data).toHaveLength(2);
      expect(response.body.data.filter((row: { current: boolean }) => row.current)).toHaveLength(1);
    });

    it('signs out everywhere', async () => {
      const first = await signIn(app, AGENT_EMAIL);
      const second = await signIn(app, AGENT_EMAIL);

      await request(app)
        .post('/api/v1/auth/logout-all')
        .set(...bearer(first.accessToken))
        .expect(200);

      await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(second.accessToken))
        .expect(401);
    });
  });
});
