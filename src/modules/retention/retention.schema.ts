import { z } from 'zod';

export const sweepBody = z.object({
  /**
   * Defaults to **true**, unlike every other flag in this API.
   *
   * The sweep destroys data irreversibly, and an operator who POSTs an empty
   * body to find out what this endpoint does should get a report, not a deletion.
   * Actually running it means saying so.
   */
  dryRun: z.boolean().default(true),
});

export type SweepBody = z.infer<typeof sweepBody>;
