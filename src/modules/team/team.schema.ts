import { z } from 'zod';

export const teamIdParams = z.object({ id: z.uuid() });
export const teamMemberParams = z.object({ id: z.uuid(), userId: z.uuid() });

export const createTeamBody = z.object({
  name: z.string().trim().min(2).max(96),
  description: z.string().trim().max(500).optional(),
});

export const updateTeamBody = z
  .object({
    name: z.string().trim().min(2).max(96).optional(),
    description: z.string().trim().max(500).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

export const addMemberBody = z.object({
  userId: z.uuid(),
  isLead: z.boolean().default(false),
});

export type CreateTeamBody = z.infer<typeof createTeamBody>;
export type UpdateTeamBody = z.infer<typeof updateTeamBody>;
export type AddMemberBody = z.infer<typeof addMemberBody>;
