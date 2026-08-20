import { z } from 'zod';

export const tagIdParams = z.object({ id: z.uuid() });

export const createTagBody = z.object({
  name: z.string().trim().min(2).max(48),
  /** Hex colour for the console; validated so the UI can trust it. */
  colour: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour such as #1f2430')
    .optional(),
});

export type CreateTagBody = z.infer<typeof createTagBody>;
