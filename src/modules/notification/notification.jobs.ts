import { env } from '../../config/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { JOB, registerHandler } from '../../lib/queue/index.js';
import * as notificationService from './notification.service.js';

const log = createModuleLogger('notification:jobs');

/**
 * The morning digest.
 *
 * `07:00` in `DEFAULT_TIMEZONE` — pg-boss is given the zone with the schedule,
 * so this is 07:00 in Harare rather than 07:00 UTC, which would land at 09:00
 * local and miss the point of arriving before the desk opens.
 *
 * Serial, and idempotent only in the weak sense that running it twice sends two
 * emails. That is acceptable for a digest and is why it is not used for anything
 * that changes state.
 */
export function registerNotificationJobs(): void {
  registerHandler(
    JOB.notificationDigest,
    async () => {
      const result = await notificationService.sendDailyDigest();

      if (result.failed > 0) {
        log.warn('digest finished with delivery failures', result);
      }
    },
    { cron: env.NOTIFICATION_DIGEST_CRON, concurrency: 1 },
  );
}
