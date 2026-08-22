import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../config/index.js';

const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(255));

export const customerIdParams = z.object({ id: z.uuid() });
export const customerAccountParams = z.object({ id: z.uuid(), accountId: z.uuid() });

export const listCustomersQuery = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  tier: z.enum(['standard', 'priority', 'vip']).optional(),
  cursor: z.string().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const createCustomerBody = z.object({
  email,
  fullName: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(6).max(32).optional(),
  /** ISO 639-1; Zimbabwe's official languages include en, sn and nd. */
  language: z.string().trim().length(2).toLowerCase().optional(),
  tier: z.enum(['standard', 'priority', 'vip']).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const updateCustomerBody = z
  .object({
    fullName: z.string().trim().min(2).max(160).optional(),
    /**
     * Settable since Phase 8, because a customer can now exist without one: a
     * person who reached the desk over WhatsApp has a number and no address, and
     * until an agent records the one they give out every email path for them —
     * the CSAT survey most of all — has nowhere to go.
     *
     * Not nullable, unlike `phone` and `notes`. Clearing an address is not an
     * edit, it is severing the identity key inbound mail threads on and every
     * other customer's uniqueness check depends on; a record that should not be
     * reachable is deleted or merged, which are their own endpoints.
     */
    email: email.optional(),
    phone: z.string().trim().min(6).max(32).nullable().optional(),
    language: z.string().trim().length(2).toLowerCase().optional(),
    tier: z.enum(['standard', 'priority', 'vip']).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

export const linkAccountBody = z.object({
  productId: z.uuid(),
  externalAccountId: z.string().trim().min(1).max(128),
  status: z.string().trim().max(48).optional(),
});

export const mergeCustomerBody = z.object({
  /** The record to fold in and retire. */
  duplicateId: z.uuid(),
});

export type ListCustomersQuery = z.infer<typeof listCustomersQuery>;
export type CreateCustomerBody = z.infer<typeof createCustomerBody>;
export type UpdateCustomerBody = z.infer<typeof updateCustomerBody>;
export type LinkAccountBody = z.infer<typeof linkAccountBody>;
export type MergeCustomerBody = z.infer<typeof mergeCustomerBody>;
