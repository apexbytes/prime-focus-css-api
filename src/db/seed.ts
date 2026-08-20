import { closeDatabase } from './client.js';
import { seedIdentity } from './seeds/identity.js';
import { createModuleLogger } from '../lib/logger/index.js';

const log = createModuleLogger('db:seed');

/** CLI entry point: `npm run db:seed`. Safe to run repeatedly. */
seedIdentity()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error('seed failed', { err: error });
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  });
