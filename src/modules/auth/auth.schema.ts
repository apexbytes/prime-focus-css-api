import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, env, MAX_PAGE_SIZE } from '../../config/index.js';
import { loginOutcome } from './auth.model.js';

/** Emails are normalised here so every layer below sees one canonical form. */
const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(255));

const password = z.string().min(env.PASSWORD_MIN_LENGTH).max(200);

export const loginBody = z.object({
  email,
  password: z.string().min(1).max(200),
  /** Opaque token from a previous "trust this device". */
  deviceToken: z.string().min(20).max(200).optional(),
});

export const verifyOtpBody = z.object({
  challengeId: z.uuid(),
  code: z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{${env.OTP_LENGTH}}$`), `must be ${env.OTP_LENGTH} digits`),
  trustDevice: z.boolean().optional(),
});

/**
 * Only the challenge id: it is a v7 UUID held solely by the client that just
 * passed the password step, and abuse is bounded by the per-challenge send cap
 * and cooldown. Asking for the password again buys nothing.
 */
export const resendOtpBody = z.object({
  challengeId: z.uuid(),
});

export const refreshBody = z.object({
  refreshToken: z.string().min(20).max(200),
});

export const forgotPasswordBody = z.object({ email });

export const resetPasswordBody = z.object({
  token: z.string().min(20).max(200),
  password,
});

export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: password,
});

export const sessionIdParams = z.object({ id: z.uuid() });

/** For the routes mounted under /users/:id/sessions. */
export const userIdParams = z.object({ id: z.uuid() });
export const userSessionParams = z.object({ id: z.uuid(), sessionId: z.uuid() });

export const listLoginAttemptsQuery = z.object({
  userId: z.uuid().optional(),
  /** Free text, not `email`: the interesting rows are the ones that matched no account. */
  email: z.string().trim().toLowerCase().min(1).max(255).optional(),
  outcome: z.enum(loginOutcome.enumValues).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type LoginBody = z.infer<typeof loginBody>;
export type VerifyOtpBody = z.infer<typeof verifyOtpBody>;
export type ResendOtpBody = z.infer<typeof resendOtpBody>;
export type RefreshBody = z.infer<typeof refreshBody>;
export type ForgotPasswordBody = z.infer<typeof forgotPasswordBody>;
export type ResetPasswordBody = z.infer<typeof resetPasswordBody>;
export type ChangePasswordBody = z.infer<typeof changePasswordBody>;
export type ListLoginAttemptsQuery = z.infer<typeof listLoginAttemptsQuery>;
