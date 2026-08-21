import { z } from 'zod';

/**
 * Every report takes the same window and the same optional product filter, so
 * one schema covers all five endpoints. `from`/`to` are instants; the views are
 * bucketed by local day and the conversion happens in `report.range.ts`.
 */
export const reportQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  productId: z.uuid().optional(),
});

export const agentReportQuery = reportQuery.extend({
  /** One agent, for a one-to-one review rather than a league table. */
  userId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ReportQuery = z.infer<typeof reportQuery>;
export type AgentReportQuery = z.infer<typeof agentReportQuery>;
