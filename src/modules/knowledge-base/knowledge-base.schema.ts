import { z } from 'zod';

const KB_STATUSES = ['draft', 'in_review', 'published', 'archived'] as const;
const KB_VISIBILITIES = ['internal', 'public'] as const;

export const idParams = z.object({ id: z.uuid() });

/** Accepts a slug as well as an id, because a KB link is a slug in practice. */
export const articleRefParams = z.object({
  id: z.string().trim().min(1).max(160),
});

const keywords = z
  .array(z.string().trim().min(2).max(48))
  .max(25)
  .transform((values) => [...new Set(values.map((value) => value.toLowerCase()))]);

export const createArticleBody = z.object({
  title: z.string().trim().min(4).max(200),
  summary: z.string().trim().min(4).max(500).optional(),
  body: z.string().trim().min(20).max(50_000),
  keywords: keywords.optional(),
  /** Null is meaningful: an article that applies to every product. */
  productId: z.uuid().nullish(),
  categoryId: z.uuid().nullish(),
  /**
   * Required, with no default, for the same reason message `visibility` is:
   * `internal` articles are agent runbooks, and `GET /kb/suggest` puts articles
   * in front of customers. A wrong default here leaks fraud procedure.
   */
  visibility: z.enum(KB_VISIBILITIES),
});

export const updateArticleBody = z
  .object({
    title: z.string().trim().min(4).max(200).optional(),
    summary: z.string().trim().min(4).max(500).nullish(),
    body: z.string().trim().min(20).max(50_000).optional(),
    keywords: keywords.optional(),
    productId: z.uuid().nullish(),
    categoryId: z.uuid().nullish(),
    visibility: z.enum(KB_VISIBILITIES).optional(),
    /**
     * `published` is accepted here only so the state machine can refuse it with
     * a message that says where to publish instead. Rejecting it at the schema
     * gives the caller a bare list of enum members and no idea what to do next.
     */
    status: z.enum(KB_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

export const listArticlesQuery = z.object({
  productId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  status: z.enum(KB_STATUSES).optional(),
  visibility: z.enum(KB_VISIBILITIES).optional(),
  q: z.string().trim().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(64).optional(),
});

export const searchQuery = z.object({
  q: z.string().trim().min(1).max(512),
  productId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  /**
   * Agent runbooks are included only when asked for, so a console screen shared
   * with a customer cannot show one by accident.
   */
  includeInternal: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/**
 * The deflection call, made while the customer is still typing their query, so
 * both fields are optional — a subject alone is enough to try with.
 */
export const suggestQuery = z
  .object({
    subject: z.string().trim().max(500).optional(),
    body: z.string().trim().max(10_000).optional(),
    productId: z.uuid().optional(),
    ticketId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(20).optional(),
  })
  .refine((value) => Boolean(value.subject ?? value.body), 'provide subject or body');

export const feedbackBody = z.object({
  helpful: z.boolean(),
  comment: z.string().trim().max(2000).optional(),
  /** Ties the vote to the ticket the reader was working, for reporting. */
  ticketId: z.uuid().optional(),
});

export const revisionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateArticleBody = z.infer<typeof createArticleBody>;
export type UpdateArticleBody = z.infer<typeof updateArticleBody>;
export type ListArticlesQuery = z.infer<typeof listArticlesQuery>;
export type SearchQuery = z.infer<typeof searchQuery>;
export type SuggestQuery = z.infer<typeof suggestQuery>;
export type FeedbackBody = z.infer<typeof feedbackBody>;
export type RevisionsQuery = z.infer<typeof revisionsQuery>;
