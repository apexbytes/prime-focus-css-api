import { z } from 'zod';

export const macroIdParams = z.object({ id: z.uuid() });
export const applyMacroParams = z.object({ id: z.uuid(), ticketId: z.uuid() });

/** Mirrors MacroActions; strict so a typo cannot be silently stored in jsonb. */
export const macroActions = z
  .object({
    status: z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    categoryId: z.uuid().optional(),
    addTags: z.array(z.string().trim().min(2).max(48)).max(10).optional(),
    assignTo: z.enum(['self', 'unassign']).optional(),
  })
  .strict();

export const listMacrosQuery = z.object({ productId: z.uuid().optional() });

export const createMacroBody = z.object({
  name: z.string().trim().min(2).max(96),
  productId: z.uuid().optional(),
  body: z.string().trim().max(20_000).optional(),
  actions: macroActions.default({}),
});

export const updateMacroBody = z
  .object({
    name: z.string().trim().min(2).max(96).optional(),
    body: z.string().trim().max(20_000).nullable().optional(),
    actions: macroActions.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

export type ListMacrosQuery = z.infer<typeof listMacrosQuery>;
export type CreateMacroBody = z.infer<typeof createMacroBody>;
export type UpdateMacroBody = z.infer<typeof updateMacroBody>;
