import { env } from '../../config/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { JOB, registerHandler } from '../../lib/queue/index.js';
import * as retentionService from './retention.service.js';

const log = createModuleLogger('retention:jobs');

/**
 * The retention sweep, weekly.
 *
 * Weekly rather than daily because the cutoffs move by a day at a time and
 * nothing is urgent: data that has been on file for five years is not more
 * compliant for going six days earlier. Sunday at 03:00 local, when the desk is
 * closed and the batch has the database to itself.
 *
 * This is the one scheduled job that runs for real rather than dry — the
 * endpoint dry-runs by default, the cron does not, because a schedule that only
 * ever reports would satisfy nothing.
 */
export function registerRetentionJobs(): void {
  registerHandler(
    JOB.retentionSweep,
    async () => {
      if (!env.RETENTION_SWEEP_ENABLED) {
        log.info('retention sweep is disabled; nothing was touched');
        return;
      }

      const result = await retentionService.sweep({ dryRun: false });

      if (result.moreRemaining) {
        // Deliberately not re-enqueued. A backlog large enough to exceed the
        // batch limit is a first run on an old database, and grinding through it
        // a week at a time is safer than a self-perpetuating job nobody is
        // watching deleting everything in one night.
        log.warn('retention sweep hit its batch limit; more remains for the next run', result);
      }
    },
    { cron: env.RETENTION_SWEEP_CRON, concurrency: 1 },
  );
}
