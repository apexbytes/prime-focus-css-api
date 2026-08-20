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

// -- phase 2: identity & access ----------------------------------------------
export * from '../modules/role/role.model.js';
export * from '../modules/user/user.model.js';
export * from '../modules/invitation/invitation.model.js';
export * from '../modules/auth/auth.model.js';
export * from '../modules/mfa/mfa.model.js';
export * from '../modules/team/team.model.js';
export * from '../modules/api-key/api-key.model.js';
export * from '../modules/audit/audit.model.js';

// -- modules ------------------------------------------------------------------
// Phase 3: product, customer, ticket, message, attachment, category, tag, macro
// Phase 4: sla, escalation, routing
// Phase 5: knowledge-base, survey, report
