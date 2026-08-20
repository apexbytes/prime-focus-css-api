import { z } from 'zod';

export const categoryIdParams = z.object({ id: z.uuid() });

export const listCategoriesQuery = z.object({
  productId: z.uuid(),
  activeOnly: z.stringbool().default(false),
});

export const createCategoryBody = z.object({
  productId: z.uuid(),
  name: z.string().trim().min(2).max(96),
  description: z.string().trim().max(500).optional(),
  parentId: z.uuid().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
});

export const updateCategoryBody = z
  .object({
    name: z.string().trim().min(2).max(96).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

export type ListCategoriesQuery = z.infer<typeof listCategoriesQuery>;
export type CreateCategoryBody = z.infer<typeof createCategoryBody>;
export type UpdateCategoryBody = z.infer<typeof updateCategoryBody>;
