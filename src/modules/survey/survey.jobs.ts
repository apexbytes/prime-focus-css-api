import { createModuleLogger } from '../../lib/logger/index.js';
import { JOB, registerHandler } from '../../lib/queue/index.js';
import * as surveyService from './survey.service.js';

const log = createModuleLogger('survey:jobs');

interface DispatchPayload {
  ticketId: string;
}

/**
 * Asks the customer how a resolved ticket went.
 *
 * Delayed rather than immediate — see `CSAT_DELAY_MINUTES` — and the ticket's
 * state is re-read when the job runs, not trusted from the payload, because the
 * delay is exactly the window in which a customer replies "that did not work"
 * and reopens it.
 */
export function registerSurveyJobs(): void {
  registerHandler<DispatchPayload>(JOB.surveyDispatch, async (payload) => {
    const result = await surveyService.dispatch(payload.ticketId);

    if (result.status === 'skipped') {
      // Debug, not warn: every reason to skip is an ordinary outcome, and a
      // warning per closed duplicate would train everyone to ignore the log.
      log.debug('csat survey not sent', { ticketId: payload.ticketId, reason: result.reason });
    }
  });
}
