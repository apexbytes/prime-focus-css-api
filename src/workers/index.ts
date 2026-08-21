import { createModuleLogger } from '../lib/logger/index.js';
import { registerAttachmentJobs } from '../modules/attachment/index.js';
import { registerEscalationJobs } from '../modules/escalation/index.js';
import { registerNotificationJobs } from '../modules/notification/index.js';
import { registerReportJobs } from '../modules/report/index.js';
import { registerRetentionJobs } from '../modules/retention/index.js';
import { registerRoutingJobs } from '../modules/routing/index.js';
import { registerSlaJobs } from '../modules/sla/index.js';
import { registerSurveyJobs } from '../modules/survey/index.js';

const log = createModuleLogger('workers');

let registered = false;

/**
 * Points every job name at its handler.
 *
 * This is bookkeeping only — a map is populated, nothing connects and nothing
 * runs — which is why it is safe to call during app assembly. `startQueue()`,
 * which does open connections and spawn workers, is called from `server.ts`
 * instead, so a test driving the Express app with Supertest never starts a
 * queue.
 *
 * Doing it at assembly time rather than only in the server has one deliberate
 * consequence: under `QUEUE_DRIVER=inline` the handlers are present, so an
 * enqueue in a test runs the real job. The alternative — registering only in
 * production — would mean the job path was never the path under test.
 *
 * A modular monolith works its own queue; when a job type needs its own process,
 * it gets its own entry point that calls only the registration it wants.
 */
export function registerJobHandlers(): void {
  if (registered) return;
  registered = true;

  registerRoutingJobs();
  registerSlaJobs();
  registerEscalationJobs();
  registerSurveyJobs();
  registerAttachmentJobs();
  registerReportJobs();
  registerNotificationJobs();
  registerRetentionJobs();

  log.debug('job handlers registered');
}
