import { env } from '../../config/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { JOB, registerHandler } from '../../lib/queue/index.js';
import * as conversationService from './conversation.service.js';

const log = createModuleLogger('conversation:jobs');

interface InboundPayload {
  inboundId: string;
}

export function registerConversationJobs(): void {
  /**
   * Files one inbound channel message onto a ticket.
   *
   * The handler throws on a failed filing, and that is the point: throwing is
   * the only way to tell pg-boss to try again, and `retryBackoff` spaces the
   * attempts out so a product-lookup that fails because nothing is configured
   * yet is retried rather than lost. `processInbound` swallows its own errors
   * into a `failed` row, so the throw is reconstructed from the result — the row
   * is the record either way, and the operator's reprocess endpoint drains
   * whatever the retries never resolved.
   */
  registerHandler<InboundPayload>(JOB.channelInboundProcess, async (payload) => {
    const result = await conversationService.processInbound(payload.inboundId);

    if (result.status === 'failed') {
      throw new Error(
        `filing inbound channel message ${payload.inboundId} failed: ${result.reason ?? 'unknown'}`,
      );
    }
  });

  /**
   * Detaches threads nobody has written on for a week.
   *
   * Hourly rather than on a timer per conversation: this is a sweep over an
   * indexed predicate, and the cost of a thread staying attached for up to an
   * extra hour is nothing — the customer's next message joins a ticket that was
   * about to be detached anyway.
   *
   * Serial, because two sweeps racing over the same predicate is one of them
   * doing no work.
   */
  registerHandler(
    JOB.conversationSweep,
    async () => {
      const closed = await conversationService.closeIdleConversations();
      // Same pass, because both are cheap indexed sweeps and a second cron entry
      // for one `delete` would be a schedule to keep in step for no reason.
      const reaped = await conversationService.reapAbandonedChats();

      if (closed > 0 || reaped > 0) {
        log.debug('conversation sweep finished', { closed, reaped });
      }
    },
    { cron: env.CONVERSATION_SWEEP_CRON, concurrency: 1 },
  );
}
