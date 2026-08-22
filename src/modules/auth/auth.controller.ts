import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor, UserActor } from '../../common/types/actor.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as authService from './auth.service.js';
import type {
  ChangePasswordBody,
  ForgotPasswordBody,
  ListLoginAttemptsQuery,
  LoginBody,
  RefreshBody,
  ResendOtpBody,
  ResetPasswordBody,
  VerifyOtpBody,
} from './auth.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

/** requireUserActor guarantees this; the helper keeps handlers readable. */
function userActor(req: Request): UserActor {
  if (req.actor?.kind !== 'user') throw AppError.unauthenticated();
  return req.actor;
}

export async function login(req: Request, res: Response): Promise<void> {
  const result = await authService.login(req.body as LoginBody);

  // 200 either way: an OTP challenge is a successful first step, not an error.
  sendSuccess(res, result);
}

export async function verifyOtp(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await authService.verifyOtp(req.body as VerifyOtpBody));
}

export async function resendOtp(req: Request, res: Response): Promise<void> {
  const { challengeId } = req.body as ResendOtpBody;
  const result = await authService.resendOtp(challengeId);
  sendSuccess(res, result);
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as RefreshBody;
  sendSuccess(res, await authService.refresh(refreshToken));
}

export async function me(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await authService.me(userActor(req)));
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logout(userActor(req));
  sendNoContent(res);
}

export async function logoutEverywhere(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await authService.logoutEverywhere(userActor(req)));
}

export async function listSessions(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await authService.listSessions(userActor(req)));
}

export async function revokeSession(req: Request, res: Response): Promise<void> {
  await authService.revokeSession(userActor(req), req.params.id as string);
  sendNoContent(res);
}

// -- mounted under /users/:id ------------------------------------------------

export async function listUserSessions(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await authService.listSessionsFor(req.params.id as string, actorOf(req)));
}

export async function revokeUserSession(req: Request, res: Response): Promise<void> {
  await authService.revokeSessionFor(
    req.params.id as string,
    req.params.sessionId as string,
    actorOf(req),
  );
  sendNoContent(res);
}

export async function listLoginAttempts(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListLoginAttemptsQuery;

  // One extra row tells us whether another page exists without a count query.
  const rows = await authService.listLoginAttempts({ ...query, limit: query.limit + 1 });
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;

  sendSuccess(res, items, {
    pagination: {
      limit: query.limit,
      hasMore,
      nextCursor: hasMore ? (items.at(-1)?.createdAt.toISOString() ?? null) : null,
    },
  });
}

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const { email } = req.body as ForgotPasswordBody;
  await authService.requestPasswordReset(email);

  // Always the same answer, so this endpoint cannot be used to test whether an
  // address has an account.
  sendSuccess(
    res,
    { message: 'If that address belongs to an active account, a reset link has been sent.' },
    { status: 202 },
  );
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const { token, password } = req.body as ResetPasswordBody;
  await authService.resetPassword(token, password);
  sendSuccess(res, { message: 'Password updated. Please sign in again.' });
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const { currentPassword, newPassword } = req.body as ChangePasswordBody;
  await authService.changePassword(userActor(req), currentPassword, newPassword);
  sendSuccess(res, { message: 'Password updated. Other sessions have been signed out.' });
}
