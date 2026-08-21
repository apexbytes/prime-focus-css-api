import { onSignal, SIGNAL } from '../lib/cache/index.js';
import { createModuleLogger } from '../lib/logger/index.js';
import { onPermissionInvalidation } from '../modules/role/index.js';
import { onCalendarInvalidation } from '../modules/sla/index.js';

const log = createModuleLogger('subscribers');

let registered = false;

/**
 * Points every cache-invalidation signal at the cache it clears.
 *
 * The same bookkeeping-only contract as `registerJobHandlers()`: a map is
 * populated and nothing connects, so it is safe during app assembly.
 * `startSignals()` — which opens the Redis subscriber — is called from
 * `server.ts`, so a Supertest run never opens a socket.
 *
 * Handlers registered here clear the local cache and do **not** re-publish;
 * that separation is what keeps a signal from bouncing between instances
 * forever.
 */
export function registerCacheSubscribers(): void {
  if (registered) return;
  registered = true;

  onSignal(SIGNAL.permissions, onPermissionInvalidation);
  onSignal(SIGNAL.calendars, onCalendarInvalidation);

  log.debug('cache subscribers registered');
}
