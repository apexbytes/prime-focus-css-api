import { z } from 'zod';

/**
 * The token from the email link.
 *
 * A URL parameter, unlike the invitation and reset tokens, which the rest of
 * this API accepts in a body only. The trade-off is deliberate and narrow: a
 * one-click rating link cannot POST, and this token grants exactly one thing —
 * the ability to put a score on one already-resolved ticket. It carries no
 * session, reads nothing but the reference the customer already has, and
 * expires. An invitation token, which sets a password, gets no such exception.
 */
export const tokenParams = z.object({
  token: z.string().trim().min(20).max(200),
});

export const respondBody = z.object({
  /** 1–5. Named `score` rather than `rating` to match the CSAT metric. */
  score: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
});

export const listSurveysQuery = z.object({
  productId: z.uuid().optional(),
  ratedUserId: z.uuid().optional(),
  /** Only answered surveys, which is what a quality review actually wants. */
  answeredOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(64).optional(),
});

export const ticketIdParams = z.object({ ticketId: z.uuid() });

export type RespondBody = z.infer<typeof respondBody>;
export type ListSurveysQuery = z.infer<typeof listSurveysQuery>;
