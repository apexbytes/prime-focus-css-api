import { closeDatabase } from './client.js';
import { seedCatalogue } from './seeds/catalogue.js';
import { seedIdentity } from './seeds/identity.js';
import { seedServiceLevels } from './seeds/service-levels.js';
import { createModuleLogger } from '../lib/logger/index.js';

const log = createModuleLogger('db:seed');

/** CLI entry point: `npm run db:seed`. Safe to run repeatedly. */
seedIdentity()
  .then(seedCatalogue)
  // After the catalogue: an SLA policy is per product, and the default team is
  // attached to products that have none.
  .then(seedServiceLevels)
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error('seed failed', { err: error });
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  });
