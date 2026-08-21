import { createModuleLogger } from '../../lib/logger/index.js';
import { enqueue, JOB, registerHandler } from '../../lib/queue/index.js';
import * as routingService from './routing.service.js';

const log = createModuleLogger('routing:jobs');

interface TicketJobPayload {
  ticketId: string;
}

/**
 * Triage then assignment, as two jobs rather than one.
 *
 * They are chained instead of combined so each can be retried on its own: if no
 * agent was free when `autoassign` ran, re-running it later is safe and cheap,
 * while re-running triage would rewrite a team a supervisor may since have
 * corrected by hand.
 */
export function registerRoutingJobs(): void {
  registerHandler<TicketJobPayload>(JOB.ticketTriage, async ({ ticketId }) => {
    await routingService.triage(ticketId);
    await enqueue(JOB.ticketAutoassign, { ticketId });
  });

  registerHandler<TicketJobPayload>(JOB.ticketAutoassign, async ({ ticketId }) => {
    const result = await routingService.autoassign(ticketId);

    if (!result.assignedToUserId) {
      log.debug('autoassign left ticket unassigned', { ticketId });
    }
  });
}
