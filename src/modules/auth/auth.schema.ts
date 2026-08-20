import { z } from 'zod';
import { env } from '../../config/index.js';

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

export type LoginBody = z.infer<typeof loginBody>;
export type VerifyOtpBody = z.infer<typeof verifyOtpBody>;
export type ResendOtpBody = z.infer<typeof resendOtpBody>;
export type RefreshBody = z.infer<typeof refreshBody>;
export type ForgotPasswordBody = z.infer<typeof forgotPasswordBody>;
export type ResetPasswordBody = z.infer<typeof resetPasswordBody>;
export type ChangePasswordBody = z.infer<typeof changePasswordBody>;
