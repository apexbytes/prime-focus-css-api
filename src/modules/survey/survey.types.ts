import type { CsatSurveyRow } from './survey.model.js';

/**
 * What the rating page is told before anyone has answered.
 *
 * Deliberately thin. The token is unauthenticated and arrives from an email
 * link, so this response is readable by anyone holding it — it carries the
 * reference and subject the customer already has in their inbox, and nothing
 * else about the ticket, the agent or the account.
 */
export interface SurveyPrompt {
  reference: string;
  subject: string;
  productName: string;
  customerName: string;
  /** Already answered: the page shows the score back rather than asking again. */
  score: number | null;
  comment: string | null;
  respondedAt: Date | null;
  expiresAt: Date;
}

/** Aggregate satisfaction over a period, as the reports return it. */
export interface CsatSummary {
  surveysSent: number;
  responses: number;
  /** Responses ÷ sent, 0–1. The number that says whether the rest is worth reading. */
  responseRate: number;
  averageScore: number | null;
  /** Share of responses scoring 4 or 5. */
  satisfactionRate: number | null;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

export type { CsatSurveyRow };
