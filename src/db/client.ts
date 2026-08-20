import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger as DrizzleLogger } from 'drizzle-orm';
import { Pool } from 'pg';
import { env, isProduction, SERVICE_NAME } from '../config/index.js';
import { createModuleLogger } from '../lib/logger/index.js';
import * as schema from './schema.js';

const log = createModuleLogger('db');

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  ssl: env.DB_SSL ? { rejectUnauthorized: true } : false,
  application_name: SERVICE_NAME,
  // A query that has run this long is not going to help the request that
  // started it; fail fast and free the connection.
  statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Errors on *idle* clients never reach a query's await, so they need their own
// listener or Node treats them as unhandled and kills the process.
pool.on('error', (error) => {
  log.error('idle database client error', { err: error });
});

/** Query text only — parameters can carry customer PII, so they are never logged. */
const queryLogger: DrizzleLogger = {
  logQuery(query, params) {
    log.debug('query', { query, paramCount: params.length });
  },
};

export const db: NodePgDatabase<typeof schema> = drizzle(pool, {
  schema,
  logger: isProduction ? false : queryLogger,
});

export interface DatabaseCheck {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Used by `/readyz`; bounded so a hung database cannot hang the health check. */
export async function checkDatabaseConnection(
  timeoutMs = env.READINESS_CHECK_TIMEOUT_MS,
): Promise<DatabaseCheck> {
  const startedAt = performance.now();
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      pool.query('select 1'),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`database check timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : 'unknown database error',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
  log.info('database pool closed');
}

export type Database = typeof db;
export { schema };
