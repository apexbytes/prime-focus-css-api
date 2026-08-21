import { env } from '../../config/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { JOB, registerHandler } from '../../lib/queue/index.js';
import * as reportService from './report.service.js';

const log = createModuleLogger('report:jobs');

/**
 * Rebuilds the reporting views on a schedule.
 *
 * Every fifteen minutes, which is the trade the whole reporting design rests
 * on: a dashboard is allowed to be a quarter of an hour behind, and in exchange
 * no dashboard read ever aggregates over the live ticket tables while agents are
 * working in them.
 *
 * Serial. Two concurrent `refresh materialized view concurrently` calls on the
 * same view is one of them waiting on a lock for nothing.
 */
export function registerReportJobs(): void {
  registerHandler(
    JOB.reportRefresh,
    async () => {
      const results = await reportService.refreshAll();
      const failed = results.filter((result) => result.error);

      if (failed.length > 0) {
        log.warn('reporting refresh finished with failures', {
          failed: failed.map((result) => result.view),
        });
        return;
      }

      log.debug('reporting views refreshed', {
        views: results.length,
        durationMs: results.reduce((total, result) => total + result.durationMs, 0),
      });
    },
    { cron: env.REPORT_REFRESH_CRON, concurrency: 1 },
  );
}
