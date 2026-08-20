import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../config/index.js';

const status = z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']);
const priority = z.enum(['low', 'normal', 'high', 'urgent']);
const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(255));

/** Repeatable query params arrive as a string or an array; normalise to array. */
const statusList = z
  .union([status, z.array(status)])
  .transform((value) => (Array.isArray(value) ? value : [value]))
  .optional();

const priorityList = z
  .union([priority, z.array(priority)])
  .transform((value) => (Array.isArray(value) ? value : [value]))
  .optional();

export const ticketIdParams = z.object({ id: z.uuid() });
export const ticketTagParams = z.object({ id: z.uuid(), tagId: z.uuid() });

export const listTicketsQuery = z.object({
  status: statusList,
  priority: priorityList,
  productId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  assignedToUserId: z.uuid().optional(),
  unassigned: z.stringbool().optional(),
  customerId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  search: z.string().trim().min(1).max(120).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const createTicketBody = z
  .object({
    productId: z.uuid(),
    subject: z.string().trim().min(3).max(255),
    body: z.string().trim().min(1).max(50_000),
    channel: z.enum(['web_form', 'api', 'agent']).default('agent'),
    priority: priority.optional(),
    categoryId: z.uuid().optional(),
    /** Identify the customer by id, or by email to find-or-create them. */
    customerId: z.uuid().optional(),
    customerEmail: email.optional(),
    customerName: z.string().trim().min(2).max(160).optional(),
    tags: z.array(z.string().trim().min(2).max(48)).max(10).optional(),
    assignedToUserId: z.uuid().optional(),
  })
  .refine(
    (value) => Boolean(value.customerId ?? value.customerEmail),
    'either customerId or customerEmail is required',
  );

export const updateTicketBody = z
  .object({
    subject: z.string().trim().min(3).max(255).optional(),
    priority: priority.optional(),
    categoryId: z.uuid().nullable().optional(),
    status: status.optional(),
    teamId: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

export const assignTicketBody = z.object({
  /** Null unassigns, returning the ticket to the queue. */
  assignedToUserId: z.uuid().nullable(),
  reason: z.string().trim().max(255).optional(),
});

export const reopenTicketBody = z.object({
  reason: z.string().trim().max(255).optional(),
});

export const addTagBody = z.object({ name: z.string().trim().min(2).max(48) });

export type ListTicketsQuery = z.infer<typeof listTicketsQuery>;
export type CreateTicketBody = z.infer<typeof createTicketBody>;
export type UpdateTicketBody = z.infer<typeof updateTicketBody>;
export type AssignTicketBody = z.infer<typeof assignTicketBody>;
export type ReopenTicketBody = z.infer<typeof reopenTicketBody>;
export type AddTagBody = z.infer<typeof addTagBody>;
