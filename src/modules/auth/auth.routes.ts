import { Router } from 'express';
import { authRateLimit, validate } from '../../common/middleware/index.js';
import { authenticate, requireUserActor } from './auth.middleware.js';
import {
  changePassword,
  forgotPassword,
  listSessions,
  login,
  logout,
  logoutEverywhere,
  me,
  refresh,
  resendOtp,
  resetPassword,
  revokeSession,
  verifyOtp,
} from './auth.controller.js';
import {
  changePasswordBody,
  forgotPasswordBody,
  loginBody,
  refreshBody,
  resendOtpBody,
  resetPasswordBody,
  sessionIdParams,
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
