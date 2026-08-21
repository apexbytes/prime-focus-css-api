import { customType, timestamp } from 'drizzle-orm/pg-core';

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

/**
 * Postgres `tsvector`. Drizzle has no built-in type for it, and the knowledge
 * base needs one as a generated stored column so the search index is maintained
 * by the database rather than by whichever code path last wrote an article.
 *
 * Never selected: it is written by Postgres and read only by the GIN index.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});
