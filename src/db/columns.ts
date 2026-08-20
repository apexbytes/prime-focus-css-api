import { timestamp } from 'drizzle-orm/pg-core';

/**
 * Column fragments shared by every table. Spread them into a table definition
 * so timestamp semantics cannot drift between entities.
 */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull()
    // Bumped by Drizzle on every update, so no service has to remember to.
    .$onUpdate(() => new Date()),
};

/** UTC instant, the only timestamp shape used in this schema. */
export const instant = (name: string) => timestamp(name, { withTimezone: true });
