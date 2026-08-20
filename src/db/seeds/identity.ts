import { eq, inArray, sql } from 'drizzle-orm';
import { env } from '../../config/index.js';
import {
  PERMISSION_CATALOGUE,
  SUPER_ADMIN_ROLE_CODE,
  SYSTEM_ROLES,
  resolveRolePermissions,
} from '../../common/types/permissions.js';
import { generateSecret, hashPassword } from '../../common/utils/crypto.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { permissions, rolePermissions, roles } from '../../modules/role/role.model.js';
import { users } from '../../modules/user/user.model.js';
import { db } from '../client.js';

const log = createModuleLogger('db:seed');

/**
 * Idempotent bootstrap: permissions, the system roles and their grants, and the
 * single default administrator account.
 *
 * There is no sign-up endpoint, so the seeded account is the only way into a
 * fresh deployment — every other user exists because it, or someone it invited,
 * sent an invitation.
 */
export async function seedPermissions(): Promise<void> {
  await db
    .insert(permissions)
    .values(PERMISSION_CATALOGUE.map((permission) => ({ ...permission })))
    .onConflictDoUpdate({
      target: permissions.code,
      // `excluded` is the row Postgres tried to insert, so a reworded
      // description in the catalogue updates the stored row.
      set: {
        description: sql`excluded.description`,
        category: sql`excluded.category`,
      },
    });

  log.info('permissions seeded', { count: PERMISSION_CATALOGUE.length });
}

export async function seedRoles(): Promise<void> {
  for (const definition of SYSTEM_ROLES) {
    const [role] = await db
      .insert(roles)
      .values({
        code: definition.code,
        name: definition.name,
        description: definition.description,
        isSystem: true,
      })
      .onConflictDoUpdate({
        target: roles.code,
        set: { name: definition.name, description: definition.description, isSystem: true },
      })
      .returning();

    if (!role) throw new Error(`failed to upsert role ${definition.code}`);

    const codes = resolveRolePermissions(definition);
    const grantedIds = await db
      .select({ id: permissions.id })
      .from(permissions)
      .where(inArray(permissions.code, [...codes]));

    // Replace rather than merge: this file is the source of truth for what a
    // system role grants, so a permission removed here is removed in the database.
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));
    if (grantedIds.length > 0) {
      await db
        .insert(rolePermissions)
        .values(grantedIds.map((row) => ({ roleId: role.id, permissionId: row.id })));
    }

    log.info('role seeded', { code: definition.code, permissions: grantedIds.length });
  }
}

export async function seedDefaultAdmin(): Promise<void> {
  const email = env.SEED_ADMIN_EMAIL.trim().toLowerCase();

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    log.info('default administrator already exists, leaving it untouched', { email });
    return;
  }

  const [superAdmin] = await db
    .select()
    .from(roles)
    .where(eq(roles.code, SUPER_ADMIN_ROLE_CODE))
    .limit(1);
  if (!superAdmin) throw new Error('super_admin role missing; seed roles first');

  // A generated password is printed once. Better than a hard-coded default that
  // survives into production because nobody changed it.
  const password = env.SEED_ADMIN_PASSWORD ?? generateSecret(16);
  const generated = !env.SEED_ADMIN_PASSWORD;

  await db.insert(users).values({
    email,
    fullName: env.SEED_ADMIN_NAME,
    roleId: superAdmin.id,
    status: 'active',
    passwordHash: await hashPassword(password),
    passwordChangedAt: new Date(),
  });

  log.info('default administrator created', { email });

  if (generated) {
    // Deliberately console, not the logger: this must never land in a log file
    // or aggregator, and it is the one secret a human has to copy by hand.
    console.log(
      [
        '',
        '  ============================================================',
        '   Default administrator created',
        `   email:    ${email}`,
        `   password: ${password}`,
        '',
        '   Shown once. Sign in and change it immediately.',
        '  ============================================================',
        '',
      ].join('\n'),
    );
  }
}

/** Everything a fresh database needs before anyone can sign in. */
export async function seedIdentity(): Promise<void> {
  await seedPermissions();
  await seedRoles();
  await seedDefaultAdmin();
}
