import { env, SERVICE_NAME } from '../../config/index.js';
import { checkDatabaseConnection } from '../../db/client.js';
import { checkAntivirus } from '../../lib/antivirus/index.js';
import { checkQueue } from '../../lib/queue/index.js';
import { checkRedis } from '../../lib/redis/index.js';
import { socketHealth } from '../../lib/socket/index.js';
import { isShuttingDown } from '../../common/utils/lifecycle.js';
import type { DependencyStatus, LivenessReport, ReadinessReport } from './health.types.js';

/**
 * Liveness answers "is this process alive": it must not touch dependencies, or
 * a database blip would make the orchestrator restart healthy containers.
 */
export function getLiveness(): LivenessReport {
  return {
    status: 'ok',
    service: SERVICE_NAME,
    version: env.APP_VERSION,
    commit: env.GIT_COMMIT_SHA,
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

async function checkDatabase(): Promise<DependencyStatus> {
  const result = await checkDatabaseConnection();
  return {
    name: 'postgres',
    state: result.ok ? 'ok' : 'unavailable',
    latencyMs: result.latencyMs,
    ...(result.error ? { error: result.error } : {}),
  };
}

async function checkJobQueue(): Promise<DependencyStatus> {
  const result = await checkQueue();
  return {
    name: 'queue',
    state: result.state,
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * The virus scanner.
 *
 * `not_configured` under the `none` driver, following the queue's `inline`: the
 * process is serviceable, but an operator reading this should be able to see
 * that nothing is looking at uploads. A scanner that *is* configured and
 * unreachable does fail readiness — attachments become undownloadable while it
 * is down, so an instance in that state is not fully serving.
 */
async function checkScanner(): Promise<DependencyStatus> {
  const result = await checkAntivirus();
  return {
    name: 'antivirus',
    state: result.state,
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * Redis.
 *
 * `not_configured` under the `memory` driver, following the queue's `inline`
 * and the scanner's `none`. A configured-but-unreachable Redis *does* fail
 * readiness: rate limits stop being shared and socket rooms stop spanning
 * instances, and an instance in that state is not fully serving even though
 * every request still answers.
 */
async function checkCache(): Promise<DependencyStatus> {
  const result = await checkRedis();
  return {
    name: 'redis',
    state: result.state,
    ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * The websocket server.
 *
 * Never fails readiness. Everything it offers is also reachable over REST, so
 * an instance with no realtime layer serves a console that polls — slower, not
 * broken — and taking it out of the load balancer would make that worse.
 */
function checkRealtime(): DependencyStatus {
  const result = socketHealth();
  return { name: 'realtime', state: result.state };
}

/**
 * Readiness answers "should this instance receive traffic". Dependencies added
 * in later phases register here: Resend still reports `not_configured`.
 *
 * An unreachable queue *does* fail readiness. Under `QUEUE_DRIVER=inline` it
 * reports `not_configured` instead, which is honest — jobs run, schedules do
 * not — and does not fail the probe.
 */
export async function getReadiness(): Promise<ReadinessReport> {
  const dependencies: DependencyStatus[] = await Promise.all([
    checkDatabase(),
    checkJobQueue(),
    checkScanner(),
    checkCache(),
  ]);

  dependencies.push(checkRealtime());
  dependencies.push({ name: 'resend', state: 'not_configured' });

  const draining = isShuttingDown();
  const hasFailure = dependencies.some((dependency) => dependency.state === 'unavailable');

  return {
    status: draining || hasFailure ? 'unavailable' : 'ok',
    shuttingDown: draining,
    dependencies,
    timestamp: new Date().toISOString(),
  };
}
