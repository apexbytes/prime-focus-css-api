import { z } from 'zod';

const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const TICKET_CHANNELS = ['email', 'web_form', 'api', 'agent'] as const;
const CUSTOMER_TIERS = ['standard', 'priority', 'vip'] as const;

export const ruleIdParams = z.object({ id: z.uuid() });
export const userIdParams = z.object({ id: z.uuid() });

/**
 * Every criterion is optional, and an omitted one is a wildcard. A rule with no
 * criteria at all is legal and useful: it is the catch-all at the bottom of the
 * list.
 */
export const createRoutingRuleBody = z.object({
  name: z.string().trim().min(2).max(96),
  productId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  channel: z.enum(TICKET_CHANNELS).optional(),
  customerTier: z.enum(CUSTOMER_TIERS).optional(),
  /** ISO 639-1, lower-cased so matching does not depend on how it was typed. */
  language: z
    .string()
    .trim()
    .min(2)
    .max(8)
    .transform((value) => value.toLowerCase())
    .optional(),
  requiredSkill: z.string().trim().min(2).max(48).optional(),
  assignToTeamId: z.uuid().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
});

export const updateRoutingRuleBody = z
  .object({
    name: z.string().trim().min(2).max(96).optional(),
    productId: z.uuid().nullable().optional(),
    categoryId: z.uuid().nullable().optional(),
    priority: z.enum(TICKET_PRIORITIES).nullable().optional(),
    channel: z.enum(TICKET_CHANNELS).nullable().optional(),
    customerTier: z.enum(CUSTOMER_TIERS).nullable().optional(),
    language: z
      .string()
      .trim()
      .min(2)
      .max(8)
      .transform((value) => value.toLowerCase())
      .nullable()
      .optional(),
    requiredSkill: z.string().trim().min(2).max(48).nullable().optional(),
    assignToTeamId: z.uuid().nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

/** Replaces the whole set, so an omitted skill is a removed skill. */
export const replaceSkillsBody = z.object({
  skills: z
    .array(
      z.object({
        skill: z.string().trim().min(2).max(48),
        proficiency: z.coerce.number().int().min(1).max(5).default(3),
      }),
    )
    .max(50)
    .refine(
      (value) => new Set(value.map((entry) => entry.skill.toLowerCase())).size === value.length,
      'the same skill cannot appear twice',
    ),
});

export type CreateRoutingRuleBody = z.infer<typeof createRoutingRuleBody>;
export type UpdateRoutingRuleBody = z.infer<typeof updateRoutingRuleBody>;
export type ReplaceSkillsBody = z.infer<typeof replaceSkillsBody>;
