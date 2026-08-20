import { env, SERVICE_NAME } from '../../config/index.js';
import { checkDatabaseConnection } from '../../db/client.js';
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

/**
 * Readiness answers "should this instance receive traffic". Dependencies added
 * in later phases register here: the queue in Phase 4, Resend in Phase 3.
 */
export async function getReadiness(): Promise<ReadinessReport> {
  const dependencies: DependencyStatus[] = await Promise.all([checkDatabase()]);

  dependencies.push(
    { name: 'queue', state: 'not_configured' },
    { name: 'resend', state: 'not_configured' },
  );

  const draining = isShuttingDown();
  const hasFailure = dependencies.some((dependency) => dependency.state === 'unavailable');

  return {
    status: draining || hasFailure ? 'unavailable' : 'ok',
    shuttingDown: draining,
    dependencies,
    timestamp: new Date().toISOString(),
  };
}
