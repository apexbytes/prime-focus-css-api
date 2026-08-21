import { z } from 'zod';

const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const TARGET_KINDS = ['first_response', 'resolution'] as const;
const ACTIONS = ['notify', 'reassign', 'notify_and_reassign'] as const;

export const ruleIdParams = z.object({ id: z.uuid() });

/**
 * Above 100 is allowed on purpose: a ladder that reassigns at 150% of the
 * allowance is how a badly overdue ticket gets taken off someone who is clearly
 * stuck. Capped at 500 so a typo cannot create a rung nothing ever reaches.
 */
const thresholdPercent = z.coerce.number().int().min(1).max(500);

export const createEscalationRuleBody = z.object({
  name: z.string().trim().min(2).max(96),
  productId: z.uuid().optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  targetKind: z.enum(TARGET_KINDS).optional(),
  thresholdPercent,
  action: z.enum(ACTIONS),
  notifyUserId: z.uuid().optional(),
  notifyTeamId: z.uuid().optional(),
  reassignToUserId: z.uuid().optional(),
  reassignToTeamId: z.uuid().optional(),
  raisePriority: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
});

export const updateEscalationRuleBody = z
  .object({
    name: z.string().trim().min(2).max(96).optional(),
    productId: z.uuid().nullable().optional(),
    priority: z.enum(TICKET_PRIORITIES).nullable().optional(),
    targetKind: z.enum(TARGET_KINDS).nullable().optional(),
    thresholdPercent: thresholdPercent.optional(),
    action: z.enum(ACTIONS).optional(),
    notifyUserId: z.uuid().nullable().optional(),
    notifyTeamId: z.uuid().nullable().optional(),
    reassignToUserId: z.uuid().nullable().optional(),
    reassignToTeamId: z.uuid().nullable().optional(),
    raisePriority: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

export type CreateEscalationRuleBody = z.infer<typeof createEscalationRuleBody>;
export type UpdateEscalationRuleBody = z.infer<typeof updateEscalationRuleBody>;
