/**
 * The domain events this system announces, and the envelope they travel in.
 *
 * One catalogue for both consumers — the websocket fan-out to the agent console
 * and the signed HTTP delivery to other Prime Focus systems — because two lists
 * that were meant to agree would not, and a subscription to `ticket.resolved`
 * that silently matched nothing is the sort of bug nobody reports.
 *
 * The names are stable public API the moment a subscription stores one. Adding
 * a name is free; renaming one strips it from every subscription that holds it,
 * exactly like a permission code.
 */
export const DOMAIN_EVENT = {
  ticketCreated: 'ticket.created',
  ticketUpdated: 'ticket.updated',
  ticketStatusChanged: 'ticket.status_changed',
  ticketAssigned: 'ticket.assigned',
  ticketResolved: 'ticket.resolved',
  ticketReopened: 'ticket.reopened',
  /** A thread entry was added. Metadata only — see `DomainEvent.data`. */
  messageCreated: 'ticket.message_created',
  slaBreached: 'sla.breached',
  ticketEscalated: 'ticket.escalated',
  csatReceived: 'csat.received',
} as const;

export type DomainEventType = (typeof DOMAIN_EVENT)[keyof typeof DOMAIN_EVENT];

export const ALL_DOMAIN_EVENT_TYPES: readonly DomainEventType[] = Object.values(DOMAIN_EVENT);

/**
 * The ticket, as an event carries it.
 *
 * Deliberately the fields a receiver needs to decide whether it cares, and not
 * one more. No customer email, no subject line beyond what is already in the
 * reference — a webhook endpoint is configured by an administrator, and the
 * customer whose data it forwards did not agree to that endpoint.
 */
export interface DomainEventTicket {
  id: string;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  channel: string;
  productId: string;
  categoryId: string | null;
  customerId: string;
  assignedToUserId: string | null;
  teamId: string | null;
  createdAt: Date;
}

/**
 * Every event in this system is about a ticket, so the envelope says so rather
 * than carrying a nullable `entity`. A future event about something else gets
 * its own envelope; a nullable field would make every consumer handle a case
 * that never occurs.
 */
export interface DomainEvent {
  /** Unique per event, and the receiver's deduplication key across retries. */
  id: string;
  type: DomainEventType;
  occurredAt: Date;
  /** The subscription scope, lifted out of the ticket so matching is one read. */
  productId: string;
  ticket: DomainEventTicket;
  /**
   * Event-specific detail: the status that changed, the rung that fired, the
   * score that came back.
   *
   * **Never a message body.** An internal note is agent-only, and a webhook is
   * an egress the note's author never saw; `ticket.message_created` carries the
   * message id, its visibility and who wrote it, and a receiver that needs the
   * text asks the API for it with credentials of its own.
   */
  data?: Record<string, unknown>;
}
