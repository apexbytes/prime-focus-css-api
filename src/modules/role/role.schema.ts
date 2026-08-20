import { z } from 'zod';
import { ALL_PERMISSION_CODES } from '../../common/types/permissions.js';

const permissionCode = z.enum(ALL_PERMISSION_CODES as unknown as [string, ...string[]]);

export const roleIdParams = z.object({ id: z.uuid() });

export const createRoleBody = z.object({
  /** Machine identifier; lower snake_case keeps it usable in code and configs. */
  code: z
    .string()
    .min(3)
    .max(48)
    .regex(/^[a-z][a-z0-9_]*$/, 'must be lower snake_case, starting with a letter'),
  name: z.string().min(2).max(96).trim(),
  description: z.string().max(500).trim().optional(),
  permissions: z.array(permissionCode).max(ALL_PERMISSION_CODES.length).default([]),
});

export const updateRoleBody = z
  .object({
    name: z.string().min(2).max(96).trim().optional(),
    description: z.string().max(500).trim().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

export const setPermissionsBody = z.object({
  permissions: z.array(permissionCode).max(ALL_PERMISSION_CODES.length),
});

export type CreateRoleBody = z.infer<typeof createRoleBody>;
export type UpdateRoleBody = z.infer<typeof updateRoleBody>;
export type SetPermissionsBody = z.infer<typeof setPermissionsBody>;
