import { env } from '../../config/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { JOB, registerHandler } from '../../lib/queue/index.js';
import * as slaService from './sla.service.js';

const log = createModuleLogger('sla:jobs');

/**
 * The breach scan, on a cron.
 *
 * Every minute, because an SLA is quoted in minutes and a coarser schedule would
 * make the breach timestamp a lie. It is cheap: one indexed query against
 * `ticket_sla_targets_due_idx`, which by construction only contains targets that
 * are still running.
 *
 * Escalation is a separate job rather than part of this one. The two failure
 * modes are different — a breach must be recorded exactly once, an escalation
 * may be retried harmlessly — and keeping them apart means a broken escalation
 * rule cannot stop breaches from being recorded.
 */
export function registerSlaJobs(): void {
  registerHandler(
    JOB.slaScan,
    async () => {
      const result = await slaService.scanAndEscalate();

      if (result.breached > 0) {
        log.warn('sla scan recorded breaches', result);
      }
    },
    {
      cron: env.SLA_SCAN_CRON,
      // Serial: two overlapping scans would race to mark the same target, and
      // the transaction re-read would make one of them wasted work.
      concurrency: 1,
    },
  );
}
