import { z } from 'zod';

export const productIdParams = z.object({ id: z.uuid() });
export const productAgentParams = z.object({ id: z.uuid(), userId: z.uuid() });

const supportEmail = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(255));

export const listProductsQuery = z.object({
  /** `true` limits the response to products the caller actually works. */
  mine: z.stringbool().default(false),
  activeOnly: z.stringbool().default(false),
});

export const createProductBody = z.object({
  code: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z][a-z0-9_]*$/, 'must be lower snake_case, starting with a letter'),
  name: z.string().trim().min(2).max(96),
  description: z.string().trim().max(500).optional(),
  /** Inbound mail to this address is filed against this product. */
  supportEmail: supportEmail.optional(),
});

export const updateProductBody = z
  .object({
    name: z.string().trim().min(2).max(96).optional(),
    description: z.string().trim().max(500).optional(),
    supportEmail: supportEmail.nullable().optional(),
    isActive: z.boolean().optional(),
    defaultTeamId: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

export const grantAccessBody = z.object({ userId: z.uuid() });

export type ListProductsQuery = z.infer<typeof listProductsQuery>;
export type CreateProductBody = z.infer<typeof createProductBody>;
export type UpdateProductBody = z.infer<typeof updateProductBody>;
export type GrantAccessBody = z.infer<typeof grantAccessBody>;
