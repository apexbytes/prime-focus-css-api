import { randomUUID } from 'node:crypto';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as realtimeService from '../realtime/realtime.service.js';
import * as ticketService from '../ticket/ticket.service.js';
import * as webhookService from '../webhook/webhook.service.js';
import type { DomainEvent, DomainEventTicket, DomainEventType } from './event.types.js';

const log = createModuleLogger('event');

/**
 * The one place a domain event is announced.
 *
 * Phase 6 gave the system two audiences for the same facts — the agent console
 * over a websocket, and other Prime Focus systems over signed HTTP — and this
 * exists so a service that changes a ticket tells them in one call rather than
 * two. Two call sites drift: the day somebody adds a third consumer, the
 * services that emit events must not have to learn about it.
 *
 * It lives in `modules/` rather than `common/` for the reason the layering
 * demands: it reaches two other modules' services, which nothing in `common/`
 * is allowed to do. It owns no table and has no router; it is wiring with a
 * name.
 */
export interface PublishInput {
  type: DomainEventType;
  ticket: DomainEventTicket;
  data?: Record<string, unknown>;
}

/**
 * Announces one event.
 *
 * Always called from an `afterCommit` hook: publishing a change that then rolls
 * back would tell a partner system about a ticket that does not exist, and
 * there is no retraction. Neither consumer is allowed to fail the caller — the
 * broadcast is fire-and-forget by construction, and the webhook fan-out
 * swallows its own errors — so this returns a promise only because writing
 * delivery rows is a database call.
 */
export async function publish(input: PublishInput): Promise<void> {
  const event: DomainEvent = {
    id: randomUUID(),
    type: input.type,
    occurredAt: new Date(),
    productId: input.ticket.productId,
    ticket: input.ticket,
    ...(input.data ? { data: input.data } : {}),
  };

  // Realtime first, and synchronously: an agent watching the ticket should see
  // it move before a third-party system does, and this cannot throw.
  realtimeService.emitDomainEvent(event);

  try {
    await webhookService.publish(event);
  } catch (error) {
    // Belt and braces: `publish` already swallows, and a domain event must
    // never be the reason a committed change reports a failure.
    log.error('event fan-out failed', { type: input.type, err: error });
  }
}

/**
 * The same thing for a caller that has a ticket id and not the row.
 *
 * The SLA scan and the escalation ladder both work from a projection built for
 * their own query rather than from the ticket itself, and re-reading one row is
 * cheaper than widening those queries — or than publishing a thinner event that
 * every receiver would then have to special-case.
 *
 * A ticket that has vanished is not an error: retention anonymises and deletes,
 * and an event about a row that no longer exists helps nobody.
 */
export async function publishForTicket(
  type: DomainEventType,
  ticketId: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    const ticket = await ticketService.findRawById(ticketId);
    if (!ticket) return;

    await publish({ type, ticket, ...(data ? { data } : {}) });
  } catch (error) {
    log.error('event lookup failed', { type, ticketId, err: error });
  }
}
