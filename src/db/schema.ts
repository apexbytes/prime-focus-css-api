/**
 * Single barrel of every Drizzle table in the system. `drizzle-kit` reads only
 * this file, so a table that is not re-exported here does not exist as far as
 * migrations are concerned.
 *
 * Business tables come from their module (`src/modules/<entity>/<entity>.model.ts`);
 * infrastructure tables come from `src/db/models/`.
 */

// -- infrastructure -----------------------------------------------------------
export * from './models/idempotency-key.model.js';

// -- modules ------------------------------------------------------------------
// Phase 2: auth, user, role, team, api-key, audit
// Phase 3: product, customer, ticket, message, attachment, category, tag, macro
// Phase 4: sla, escalation, routing
// Phase 5: knowledge-base, survey, report
