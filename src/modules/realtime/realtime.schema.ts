import { z } from 'zod';

export const ticketIdParams = z.object({ ticketId: z.uuid() });

export const queueCountsQuery = z.object({
  /**
   * Required rather than "all products the caller can see": a count that
   * silently spans a different set of products for each agent is a number
   * nobody can act on.
   */
  productId: z.uuid(),
});

export type QueueCountsQuery = z.infer<typeof queueCountsQuery>;
