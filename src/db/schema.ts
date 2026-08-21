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

// -- phase 3: products, customers & ticketing ---------------------------------
export * from '../modules/product/product.model.js';
export * from '../modules/customer/customer.model.js';
export * from '../modules/category/category.model.js';
export * from '../modules/ticket/ticket.model.js';
export * from '../modules/tag/tag.model.js';
export * from '../modules/message/message.model.js';
export * from '../modules/attachment/attachment.model.js';
export * from '../modules/macro/macro.model.js';
export * from '../modules/email/email.model.js';
export * from '../modules/notification/notification.model.js';

// -- phase 4: routing, service levels & escalation ---------------------------
// sla before escalation: escalation_rules references sla_target_kind.
export * from '../modules/sla/sla.model.js';
export * from '../modules/routing/routing.model.js';
export * from '../modules/escalation/escalation.model.js';

// -- phase 5: deflection & insight -------------------------------------------
// knowledge-base before report: the reporting views reference kb_view_source.
export * from '../modules/knowledge-base/knowledge-base.model.js';
export * from '../modules/survey/survey.model.js';
// The materialised views themselves are declared `.existing()` and their DDL
// lives in the migration by hand; only `report_refreshes` is a real table here.
export * from '../modules/report/report.model.js';

// -- phase 6: realtime & scale ------------------------------------------------
export * from '../modules/realtime/realtime.model.js';
export * from '../modules/webhook/webhook.model.js';
