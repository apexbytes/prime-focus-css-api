import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { seedPermissions, seedRoles } from '../../src/db/seeds/identity.js';
import { clearOutbox } from '../../src/lib/resend/index.js';
import { invalidatePermissionCache } from '../../src/modules/role/role.service.js';

/**
 * Order matters only for readability — CASCADE handles the foreign keys. The
 * migrations table is deliberately excluded.
 */
const TABLES = [
  'audit_logs',
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

/** Truncates everything and restores the permission/role baseline. */
export async function resetDatabase(): Promise<void> {
  await db.execute(sql.raw(`truncate table ${TABLES.join(', ')} restart identity cascade`));
  await seedPermissions();
  await seedRoles();

  // The cache is keyed by role id, and truncation gives roles new ids.
  invalidatePermissionCache();
  clearOutbox();
}
