import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../config/index.js';

export const userIdParams = z.object({ id: z.uuid() });

export const listUsersQuery = z.object({
  status: z.enum(['invited', 'active', 'suspended']).optional(),
  roleId: z.uuid().optional(),
  search: z.string().trim().min(1).max(120).optional(),
  cursor: z.string().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const updateUserBody = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    /** Explicit null clears the number. */
    phone: z.string().trim().min(6).max(32).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

export const changeRoleBody = z.object({ roleId: z.uuid() });

export const changeStatusBody = z.object({ status: z.enum(['active', 'suspended']) });

/**
 * Routing state. Separate from `changeStatusBody` on purpose: being at lunch and
 * being suspended are not the same fact, and conflating them would let an agent
 * set their own account status.
 */
export const changeAvailabilityBody = z.object({
  availability: z.enum(['online', 'away', 'offline']),
});

export const changeCapacityBody = z.object({
  /** Null restores `DEFAULT_AGENT_MAX_OPEN_TICKETS`; it does not mean unlimited. */
  maxOpenTickets: z.coerce.number().int().min(1).max(500).nullable(),
});

export type ListUsersQuery = z.infer<typeof listUsersQuery>;
export type UpdateUserBody = z.infer<typeof updateUserBody>;
export type ChangeRoleBody = z.infer<typeof changeRoleBody>;
export type ChangeStatusBody = z.infer<typeof changeStatusBody>;
export type ChangeAvailabilityBody = z.infer<typeof changeAvailabilityBody>;
export type ChangeCapacityBody = z.infer<typeof changeCapacityBody>;
