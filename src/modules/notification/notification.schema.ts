import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../config/index.js';

export const notificationIdParams = z.object({ id: z.uuid() });

export const listNotificationsQuery = z.object({
  unreadOnly: z.stringbool().default(false),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const updatePreferencesBody = z
  .object({
    emailOnAssignment: z.boolean().optional(),
    emailOnCustomerReply: z.boolean().optional(),
    emailOnMention: z.boolean().optional(),
    emailDigest: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;
export type UpdatePreferencesBody = z.infer<typeof updatePreferencesBody>;
