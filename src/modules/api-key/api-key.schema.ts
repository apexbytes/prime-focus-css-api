import { z } from 'zod';
import { ALL_PERMISSION_CODES } from '../../common/types/permissions.js';

const permissionCode = z.enum(ALL_PERMISSION_CODES as unknown as [string, ...string[]]);

export const apiKeyIdParams = z.object({ id: z.uuid() });

export const createApiKeyBody = z.object({
  name: z.string().min(3).max(96).trim(),
  /** Scopes are permission codes: a key can never exceed the permission model. */
  scopes: z.array(permissionCode).min(1),
  expiresAt: z.coerce.date().min(new Date(), 'must be in the future').optional(),
});

export type CreateApiKeyBody = z.infer<typeof createApiKeyBody>;
