import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../config/index.js';

export const ticketIdParams = z.object({ ticketId: z.uuid() });

export const listMessagesQuery = z.object({
  /** Set false to preview what the customer can see. */
  includeInternal: z.stringbool().default(true),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const postMessageBody = z.object({
  body: z.string().trim().min(1).max(50_000),
  bodyHtml: z.string().max(200_000).optional(),
  /**
   * `public` is emailed to the customer; `internal` never leaves the system.
   * Required rather than defaulted: defaulting this wrong sends a private note
   * to a customer, so the caller has to say which it is.
   */
  visibility: z.enum(['public', 'internal']),
});

export type ListMessagesQuery = z.infer<typeof listMessagesQuery>;
export type PostMessageBody = z.infer<typeof postMessageBody>;
