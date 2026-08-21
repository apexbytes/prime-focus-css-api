import { JOB, registerHandler } from '../../lib/queue/index.js';
import * as escalationService from './escalation.service.js';

/**
 * The escalation pass, handed off by `sla.scan` once a minute.
 *
 * Serial for the same reason the scan is: two passes at once would both try to
 * claim the same rung, and while the unique constraint makes that safe, it makes
 * one of them pointless work.
 */
export function registerEscalationJobs(): void {
  registerHandler(
    JOB.slaEscalate,
    async () => {
      await escalationService.run();
    },
    { concurrency: 1 },
  );
}
