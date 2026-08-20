import { z } from 'zod';
import { env } from '../../config/index.js';

const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(255));

export const invitationIdParams = z.object({ id: z.uuid() });

export const createInvitationBody = z.object({
  email,
  fullName: z.string().trim().min(2).max(120),
  /** The role assigned on acceptance; part of the invitation, not the accept step. */
  roleId: z.uuid(),
});

/**
 * Tokens travel in the body, never the path or query: URLs end up in browser
 * history, referrer headers and proxy logs.
 */
export const invitationTokenBody = z.object({
  token: z.string().min(20).max(200),
});

export const acceptInvitationBody = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(env.PASSWORD_MIN_LENGTH).max(200),
  /** The invitee may correct the name the administrator typed. */
  fullName: z.string().trim().min(2).max(120).optional(),
});

export type CreateInvitationBody = z.infer<typeof createInvitationBody>;
export type InvitationTokenBody = z.infer<typeof invitationTokenBody>;
export type AcceptInvitationBody = z.infer<typeof acceptInvitationBody>;
