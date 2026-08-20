import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDatabase, db, pool } from './client.js';
import { createModuleLogger } from '../lib/logger/index.js';

const log = createModuleLogger('db:migrate');

/**
 * Extensions the schema depends on. Kept out of the generated migrations because
 * they need elevated privileges: on managed Postgres a platform admin may have
 * to create them once, after which these statements are no-ops.
 */
const EXTENSIONS = ['pgcrypto', 'citext', 'pg_trgm'] as const;

async function run(): Promise<void> {
  log.info('applying database migrations');

  for (const extension of EXTENSIONS) {
    await pool.query(`create extension if not exists "${extension}"`);
  }

  await migrate(db, { migrationsFolder: 'drizzle' });
  log.info('migrations applied');
}

run()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error('migration failed', { err: error });
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  });
