import { createModuleLogger } from '../lib/logger/index.js';
import { registerEscalationJobs } from '../modules/escalation/index.js';
import { registerRoutingJobs } from '../modules/routing/index.js';
import { registerSlaJobs } from '../modules/sla/index.js';

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

  log.debug('job handlers registered');
}
