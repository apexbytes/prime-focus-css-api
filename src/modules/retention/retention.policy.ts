/**
 * What the retention policy means in dates.
 *
 * Pure, so the cutoffs that decide what gets destroyed can be tested without a
 * database. That is the whole reason this is its own file: everything downstream
 * of these two timestamps is irreversible.
 */

export interface RetentionCutoffs {
  /** Audit rows older than this are deleted outright. */
  auditLogsBefore: Date;
  /** Tickets resolved before this have their content stripped. */
  ticketContentBefore: Date;
}

export interface RetentionPolicy {
  auditLogYears: number;
  ticketYears: number;
}

/**
 * Turns "seven years" into an instant.
 *
 * Calendar years, not 365-day windows: `Date.UTC` with a decremented year
 * handles leap days on its own, and a policy quoted in years should mean the
 * same calendar day however many February 29ths fall inside it.
 */
export function cutoffsFor(policy: RetentionPolicy, now: Date = new Date()): RetentionCutoffs {
  return {
    auditLogsBefore: yearsBefore(now, policy.auditLogYears),
    ticketContentBefore: yearsBefore(now, policy.ticketYears),
  };
}

export function yearsBefore(from: Date, years: number): Date {
  const shifted = new Date(from.getTime());
  shifted.setUTCFullYear(shifted.getUTCFullYear() - years);
  return shifted;
}

/**
 * Whether a policy is coherent.
 *
 * The audit trail has to outlive the content it describes. Inverted, the sweep
 * would delete the record of a ticket's own anonymisation before deleting the
 * ticket's content — which is the one thing an auditor asks to see.
 */
export function isCoherent(policy: RetentionPolicy): boolean {
  return policy.auditLogYears >= policy.ticketYears;
}
