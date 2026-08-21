import { z } from 'zod';
import { ALL_DOMAIN_EVENT_TYPES } from '../event/event.types.js';

/**
 * Event names are validated against the catalogue here *and* in the service.
 * The duplication is deliberate: the schema gives the caller a usable error
 * listing what exists, and the service check is what protects the fan-out from
 * a subscription written by anything that is not this router.
 */
const eventTypes = z
  .array(z.enum(ALL_DOMAIN_EVENT_TYPES as unknown as [string, ...string[]]))
  .min(1, 'subscribe to at least one event')
  .max(ALL_DOMAIN_EVENT_TYPES.length);

export const createSubscriptionBody = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.url().max(2048),
  eventTypes,
  /** Omitted means every product, which is what an internal sink wants. */
  productId: z.uuid().optional(),
  description: z.string().trim().max(500).optional(),
});

export const updateSubscriptionBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    url: z.url().max(2048).optional(),
    eventTypes: eventTypes.optional(),
    productId: z.uuid().nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to update' });

/** Shared by the subscription routes and the delivery redelivery route. */
export const idParams = z.object({ id: z.uuid() });

export const listDeliveriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.coerce.date().optional(),
});

export type CreateSubscriptionBody = z.infer<typeof createSubscriptionBody>;
export type UpdateSubscriptionBody = z.infer<typeof updateSubscriptionBody>;
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuery>;
