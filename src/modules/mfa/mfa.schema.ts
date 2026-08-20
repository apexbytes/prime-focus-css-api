import { z } from 'zod';

export const deviceIdParams = z.object({ id: z.uuid() });
