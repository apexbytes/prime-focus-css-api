import { boolean, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '../../db/columns.js';

/**
 * Roles and permissions are data, not code: the matrix is editable at runtime
 * without a deploy. Permission *codes* are still referenced from source, so
 * codes are append-only — never rename or repurpose one.
 */
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Stable machine identifier, e.g. `tier1_agent`. */
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  /** System roles are seeded and cannot be deleted. */
  isSystem: boolean('is_system').notNull().default(false),
  ...timestamps,
});

export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** `resource:action`, e.g. `ticket:assign`. */
  code: text('code').notNull().unique(),
  description: text('description').notNull(),
  /** Grouping for the admin UI, e.g. `tickets`, `users`. */
  category: text('category').notNull(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
    index('role_permissions_permission_idx').on(table.permissionId),
  ],
);

export type RoleRow = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type PermissionRow = typeof permissions.$inferSelect;
