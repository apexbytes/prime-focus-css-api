import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { seedCatalogue } from '../../src/db/seeds/catalogue.js';
import { seedPermissions, seedRoles } from '../../src/db/seeds/identity.js';
import { seedServiceLevels } from '../../src/db/seeds/service-levels.js';
import { clearMemoryCache } from '../../src/lib/cache/index.js';
import { clearOutbox } from '../../src/lib/resend/index.js';
import { invalidatePermissionCache } from '../../src/modules/role/role.service.js';
import { invalidateCalendarCache } from '../../src/modules/sla/sla.service.js';

/**
 * Order matters only for readability — CASCADE handles the foreign keys. The
 * migrations table is deliberately excluded.
 */
const TABLES = [
  'audit_logs',
  'webhook_deliveries',
  'webhook_subscriptions',
  'ticket_locks',
  'report_refreshes',
  'csat_surveys',
  'kb_views',
  'kb_article_feedback',
  'kb_article_revisions',
  'kb_articles',
  'escalations',
  'escalation_rules',
  'routing_rules',
  'agent_skills',
  'sla_breaches',
  'ticket_sla_targets',
  'sla_policies',
  'holidays',
  'business_hours',
  'inbound_emails',
  'outbound_emails',
  'email_events',
  'notifications',
  'notification_preferences',
  'attachments',
  'ticket_messages',
  'ticket_tags',
  'ticket_assignments',
  'ticket_watchers',
  'tickets',
  'tags',
  'macros',
  'categories',
  'customer_product_accounts',
  'customers',
  'user_products',
  'products',
  'login_attempts',
  'sessions',
  'password_reset_tokens',
  'otp_challenges',
  'trusted_devices',
  'invitations',
  'team_members',
  'teams',
  'api_keys',
  'users',
  'role_permissions',
  'roles',
  'permissions',
  'idempotency_keys',
];

/**
 * Truncates everything and restores the permission/role baseline.
 *
 * The reporting materialised views are deliberately **not** refreshed here. They
 * are derived, refreshing six of them between every case would dominate the
 * suite's runtime, and a spec that asserts on a report has to refresh anyway to
 * be asserting on its own data rather than on whatever the last refresh caught.
 */
export async function resetDatabase(): Promise<void> {
  await db.execute(sql.raw(`truncate table ${TABLES.join(', ')} restart identity cascade`));
  await seedPermissions();
  await seedRoles();
  await seedCatalogue();
  // Business hours, holidays and SLA policies: without them a ticket gets no
  // targets, and every SLA assertion would pass by doing nothing.
  await seedServiceLevels();

  // Ticket references come from a sequence, so tests would otherwise see numbers
  // climbing across files.
  await db.execute(sql.raw('alter sequence ticket_reference_seq restart with 1'));

  // The cache is keyed by role id, and truncation gives roles new ids.
  invalidatePermissionCache();
  // Calendars are cached in-process and truncation gives them new ids.
  invalidateCalendarCache();
  // The knowledge base's suggestion cache outlives a truncate otherwise, and a
  // spec that publishes an article would be answered from the previous file's.
  clearMemoryCache();
  clearOutbox();
}
