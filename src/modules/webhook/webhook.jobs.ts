import { JOB, registerHandler } from '../../lib/queue/index.js';
import * as webhookService from './webhook.service.js';

interface DeliverPayload {
  deliveryId: string;
}

/**
 * Delivers one webhook.
 *
 * The handler deliberately lets a retryable failure throw: that is the only way
 * to tell pg-boss to try again, and `retryBackoff` then spaces the attempts out
 * so a receiver that is down for a minute is not hammered for that minute.
 * Exhausting the attempt budget is *not* a throw — the delivery is recorded as
 * failed and the job ends, because retrying past the operator's limit would
 * make the limit a suggestion.
 */
export function registerWebhookJobs(): void {
  registerHandler<DeliverPayload>(JOB.webhookDeliver, async (payload) => {
    await webhookService.deliver(payload.deliveryId);
  });
}
