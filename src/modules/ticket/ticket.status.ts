import { AppError } from '../../common/errors/index.js';
import type { TicketStatus } from './ticket.model.js';

/**
 * Legal transitions. Kept as data rather than conditionals so the whole
 * lifecycle is readable in one place, and so an illegal move is a validation
 * error rather than a silently-accepted update.
 *
 * `closed` is terminal from the API's perspective: a customer replying to a
 * closed ticket reopens it, which the message module does explicitly via
 * `reopen`, rather than by transitioning here.
 */
const TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  new: ['open', 'pending', 'on_hold', 'resolved', 'closed'],
  open: ['pending', 'on_hold', 'resolved', 'closed'],
  pending: ['open', 'on_hold', 'resolved', 'closed'],
  on_hold: ['open', 'pending', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: ['open'],
};

/** Statuses that stop the SLA clock in Phase 4. */
export const CLOCK_PAUSED_STATUSES: readonly TicketStatus[] = ['pending', 'on_hold'];

export const OPEN_STATUSES: readonly TicketStatus[] = ['new', 'open', 'pending', 'on_hold'];

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TicketStatus, to: TicketStatus): void {
  if (!canTransition(from, to)) {
    throw AppError.validation(`A ticket cannot go from ${from} to ${to}`, {
      details: [{ field: 'status', issue: `allowed: ${TRANSITIONS[from].join(', ')}` }],
    });
  }
}

/** Timestamps that a status change implies, so callers cannot forget them. */
export function timestampsForStatus(to: TicketStatus): {
  resolvedAt?: Date | null;
  closedAt?: Date | null;
} {
  const now = new Date();

  switch (to) {
    case 'resolved':
      return { resolvedAt: now, closedAt: null };
    case 'closed':
      return { closedAt: now };
    // Reopening clears both, otherwise resolution metrics would count the first
    // attempt as the outcome.
    case 'open':
    case 'new':
    case 'pending':
    case 'on_hold':
      return { resolvedAt: null, closedAt: null };
  }
}
