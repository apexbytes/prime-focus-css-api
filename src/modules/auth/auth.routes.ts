import { Router } from 'express';
import { authRateLimit, validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission, requireUserActor } from './auth.middleware.js';
import {
  changePassword,
  forgotPassword,
  listLoginAttempts,
  listSessions,
  listUserSessions,
  login,
  logout,
  logoutEverywhere,
  me,
  refresh,
  resendOtp,
  resetPassword,
  revokeSession,
  revokeUserSession,
  verifyOtp,
} from './auth.controller.js';
import {
  changePasswordBody,
  forgotPasswordBody,
  listLoginAttemptsQuery,
  loginBody,
  refreshBody,
  resendOtpBody,
  resetPasswordBody,
  sessionIdParams,
  userIdParams,
  userSessionParams,
  verifyOtpBody,
} from './auth.schema.js';

export const authRouter: Router = Router();

/**
 * Credential endpoints carry a tighter limiter than the rest of the API: these
 * are the only routes where guessing has a payoff.
 */
authRouter.post('/login', authRateLimit, validate({ body: loginBody }), login);
authRouter.post('/otp/verify', authRateLimit, validate({ body: verifyOtpBody }), verifyOtp);
authRouter.post('/otp/resend', authRateLimit, validate({ body: resendOtpBody }), resendOtp);
authRouter.post('/refresh', validate({ body: refreshBody }), refresh);

authRouter.post(
  '/password/forgot',
  authRateLimit,
  validate({ body: forgotPasswordBody }),
  forgotPassword,
);
authRouter.post(
  '/password/reset',
  authRateLimit,
  validate({ body: resetPasswordBody }),
  resetPassword,
);

// -- authenticated ------------------------------------------------------------

authRouter.use(authenticate, requireUserActor);

authRouter.get('/me', me);
authRouter.post('/logout', logout);
authRouter.post('/logout-all', logoutEverywhere);
authRouter.post('/password/change', validate({ body: changePasswordBody }), changePassword);
authRouter.get('/sessions', listSessions);
authRouter.delete('/sessions/:id', validate({ params: sessionIdParams }), revokeSession);

/**
 * The one staff-facing read on this router, and the only way back out of the
 * attempt log.
 *
 * Behind `audit:read` rather than `user:manage` because the rows worth looking
 * at hardest — a run of `unknown_email` from one address — belong to no staff
 * account at all, so this is a question about the system, not about a colleague.
 */
authRouter.get(
  '/login-attempts',
  requirePermission('audit:read'),
  validate({ query: listLoginAttemptsQuery }),
  listLoginAttempts,
);

/**
 * Mounted at /users/:id/sessions, on the same reasoning as the skills router: a
 * session belongs to a person, and is addressed under that person, but the table
 * and every rule about it live here.
 *
 * `user:manage` for both: this is the account-administration view, distinct from
 * `/auth/sessions`, which is you looking at your own.
 */
export const userSessionRouter: Router = Router({ mergeParams: true });

userSessionRouter.use(authenticate, requireUserActor);

userSessionRouter.get(
  '/',
  requirePermission('user:manage'),
  validate({ params: userIdParams }),
  listUserSessions,
);
userSessionRouter.delete(
  '/:sessionId',
  requirePermission('user:manage'),
  validate({ params: userSessionParams }),
  revokeUserSession,
);
