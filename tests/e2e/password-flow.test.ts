import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closeDatabase } from '../../src/db/client.js';
import { readOutbox } from '../../src/lib/resend/index.js';
import { resetDatabase } from '../helpers/db.js';
import {
  STRONG_PASSWORD,
  bearer,
  createActiveUser,
  resetTokenFor,
  signIn,
} from '../helpers/identity.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const app = createApp();

const EMAIL = 'agent@primefocus.co.zw';
const NEW_PASSWORD = 'a-brand-new-passphrase-77';

describe.runIf(enabled)('passwords', () => {
  beforeEach(async () => {
    await resetDatabase();
    await createActiveUser({ email: EMAIL, roleCode: 'tier1_agent', fullName: 'Agent' });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('forgotten password', () => {
    it('answers identically for a known and an unknown address', async () => {
      const known = await request(app).post('/api/v1/auth/password/forgot').send({ email: EMAIL });
      const unknown = await request(app)
        .post('/api/v1/auth/password/forgot')
        .send({ email: 'ghost@primefocus.co.zw' });

      expect(known.status).toBe(202);
      expect(unknown.status).toBe(202);
      expect(unknown.body.data).toEqual(known.body.data);

      // Only the real account gets an email.
      expect(readOutbox().filter((message) => message.kind === 'password_reset')).toHaveLength(1);
    });

    it('resets the password and signs every session out', async () => {
      const session = await signIn(app, EMAIL);
      await request(app).post('/api/v1/auth/password/forgot').send({ email: EMAIL }).expect(202);

      const response = await request(app)
        .post('/api/v1/auth/password/reset')
        .send({ token: resetTokenFor(EMAIL), password: NEW_PASSWORD });

      expect(response.status).toBe(200);

      // A reset is the remedy for a compromise, so existing access dies.
      await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(session.accessToken))
        .expect(401);
      await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);

      // Old password gone, new password works.
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: STRONG_PASSWORD })
        .expect(401);
      await signIn(app, EMAIL, NEW_PASSWORD);
    });

    it('revokes trusted devices too, so the code is required again', async () => {
      const session = await signIn(app, EMAIL, STRONG_PASSWORD, { trustDevice: true });
      await request(app).post('/api/v1/auth/password/forgot').send({ email: EMAIL }).expect(202);
      await request(app)
        .post('/api/v1/auth/password/reset')
        .send({ token: resetTokenFor(EMAIL), password: NEW_PASSWORD })
        .expect(200);

      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: NEW_PASSWORD, deviceToken: session.deviceToken });

      expect(login.body.data.status).toBe('otp_required');
    });

    it('sends a notification that the password changed', async () => {
      await request(app).post('/api/v1/auth/password/forgot').send({ email: EMAIL }).expect(202);
      await request(app)
        .post('/api/v1/auth/password/reset')
        .send({ token: resetTokenFor(EMAIL), password: NEW_PASSWORD })
        .expect(200);

      const notices = readOutbox().filter((message) => message.kind === 'password_changed');
      expect(notices).toHaveLength(1);
      expect(notices[0]?.to).toBe(EMAIL);
    });

    it('burns the token after one use', async () => {
      await request(app).post('/api/v1/auth/password/forgot').send({ email: EMAIL }).expect(202);
      const token = resetTokenFor(EMAIL);

      await request(app)
        .post('/api/v1/auth/password/reset')
        .send({ token, password: NEW_PASSWORD })
        .expect(200);

      const replay = await request(app)
        .post('/api/v1/auth/password/reset')
        .send({ token, password: 'yet-another-password-99' });

      expect(replay.status).toBe(400);
      expect(replay.body.error.code).toBe('RESET_TOKEN_INVALID');
    });

    it('invalidates an earlier request when a new one is made', async () => {
      await request(app).post('/api/v1/auth/password/forgot').send({ email: EMAIL }).expect(202);
      const firstToken = resetTokenFor(EMAIL);

      await request(app).post('/api/v1/auth/password/forgot').send({ email: EMAIL }).expect(202);
      const secondToken = resetTokenFor(EMAIL);
      expect(secondToken).not.toBe(firstToken);

      await request(app)
        .post('/api/v1/auth/password/reset')
        .send({ token: firstToken, password: NEW_PASSWORD })
        .expect(400);
      await request(app)
        .post('/api/v1/auth/password/reset')
        .send({ token: secondToken, password: NEW_PASSWORD })
        .expect(200);
    });

    it('rejects an unknown token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/password/reset')
        .send({ token: 'x'.repeat(43), password: NEW_PASSWORD });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('RESET_TOKEN_INVALID');
    });
  });

  describe('changing a known password', () => {
    it('requires the current password', async () => {
      const session = await signIn(app, EMAIL);

      const response = await request(app)
        .post('/api/v1/auth/password/change')
        .set(...bearer(session.accessToken))
        .send({ currentPassword: 'not-it', newPassword: NEW_PASSWORD });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('refuses a new password identical to the current one', async () => {
      const session = await signIn(app, EMAIL);

      const response = await request(app)
        .post('/api/v1/auth/password/change')
        .set(...bearer(session.accessToken))
        .send({ currentPassword: STRONG_PASSWORD, newPassword: STRONG_PASSWORD });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('PASSWORD_REUSED');
    });

    it('changes the password and signs other sessions out', async () => {
      const first = await signIn(app, EMAIL);
      const second = await signIn(app, EMAIL);

      await request(app)
        .post('/api/v1/auth/password/change')
        .set(...bearer(first.accessToken))
        .send({ currentPassword: STRONG_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(200);

      await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(second.accessToken))
        .expect(401);
      await signIn(app, EMAIL, NEW_PASSWORD);
    });

    it('rejects a weak new password', async () => {
      const session = await signIn(app, EMAIL);

      const response = await request(app)
        .post('/api/v1/auth/password/change')
        .set(...bearer(session.accessToken))
        .send({ currentPassword: STRONG_PASSWORD, newPassword: 'short' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('requires authentication', async () => {
      await request(app)
        .post('/api/v1/auth/password/change')
        .send({ currentPassword: STRONG_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(401);
    });
  });
});
