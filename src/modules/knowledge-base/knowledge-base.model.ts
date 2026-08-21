import { sql, type SQL } from 'drizzle-orm';
import { boolean, index, integer, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps, tsvector } from '../../db/columns.js';
import { categories } from '../category/category.model.js';
import { customers } from '../customer/customer.model.js';
import { products } from '../product/product.model.js';
import { tickets } from '../ticket/ticket.model.js';
import { users } from '../user/user.model.js';

/**
 * `in_review` is a real state rather than a flag: a knowledge base article is
 * customer-facing copy about a financial product, and the difference between
 * "somebody is writing this" and "somebody has written this and wants it
 * checked" is what a reviewer's queue is built on.
 *
 * `archived` rather than a delete: an article that turned out to be wrong has
 * usually been linked from tickets, and a dead link tells an agent nothing.
 */
export const kbArticleStatus = pgEnum('kb_article_status', [
  'draft',
  'in_review',
  'published',
  'archived',
]);

/**
 * Who may be shown an article.
 *
 * The highest-stakes flag in this module, for the same reason message
 * `visibility` is in ticketing: `internal` articles are agent runbooks —
 * escalation contacts, fraud-handling procedure, how to reverse a transfer —
 * and `GET /kb/suggest` exists precisely to put articles in front of customers.
 * The column defaults to `internal` so a row written by any future code path
 * that forgets the field fails closed; the API requires it explicitly.
 */
export const kbArticleVisibility = pgEnum('kb_article_visibility', ['internal', 'public']);

/** How a reader arrived, which is what makes deflection measurable at all. */
export const kbViewSource = pgEnum('kb_view_source', ['search', 'suggest', 'direct']);

/**
 * The `english` text-search configuration is baked into `search_vector` below.
 * It cannot be a runtime setting: the vector is stored, so changing the
 * configuration means rewriting every row, which is a migration. Queries must
 * use this same constant or they will search a stemmed index with unstemmed
 * terms and quietly miss matches.
 */
export const KB_SEARCH_CONFIG = 'english';

export const kbArticles = pgTable(
  'kb_articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable, human-readable, and safe in a URL; generated from the title once. */
    slug: text('slug').notNull().unique(),
    /** Null applies to every product — "how to read your statement" is not per product. */
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    summary: text('summary'),
    body: text('body').notNull(),
    /** Search terms the prose does not contain: "PIN", "OTP", a product's old name. */
    keywords: text('keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: kbArticleStatus('status').notNull().default('draft'),
    visibility: kbArticleVisibility('visibility').notNull().default('internal'),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    lastEditedByUserId: uuid('last_edited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    publishedAt: instant('published_at'),
    publishedByUserId: uuid('published_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Incremented on every edit; `kb_article_revisions` holds each one. */
    version: integer('version').notNull().default(1),
    viewCount: integer('view_count').notNull().default(0),
    helpfulCount: integer('helpful_count').notNull().default(0),
    notHelpfulCount: integer('not_helpful_count').notNull().default(0),
    /**
     * Maintained by Postgres, not by the service. A stored generated column
     * cannot drift from the row: there is no write path that updates the body
     * and forgets the index.
     *
     * Weighted A/B/C — a title match beats a keyword match beats a body
     * mention, which is what makes ranking useful on a corpus this small.
     *
     * `kb_keywords_text` rather than `array_to_string`, which Postgres marks
     * STABLE and therefore refuses in a generated column. The migration defines
     * it as an IMMUTABLE wrapper taking `text[]` only — see the comment there for
     * why that is sound rather than a lie about volatility.
     */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      (): SQL =>
        sql`setweight(to_tsvector('english', coalesce(${kbArticles.title}, '')), 'A') || setweight(to_tsvector('english', coalesce(kb_keywords_text(${kbArticles.keywords}), '')), 'B') || setweight(to_tsvector('english', coalesce(${kbArticles.summary}, '')), 'B') || setweight(to_tsvector('english', coalesce(${kbArticles.body}, '')), 'C')`,
    ),
    ...timestamps,
  },
  (table) => [
    index('kb_articles_search_idx').using('gin', table.searchVector),
    index('kb_articles_product_status_idx').on(table.productId, table.status),
    index('kb_articles_status_published_idx').on(table.status, table.publishedAt.desc()),
    index('kb_articles_category_idx').on(table.categoryId),
  ],
);

/**
 * Every previous version of an article, written before the edit that replaced
 * it. An article is the desk's answer to a customer; "what did we tell people
 * last month" has to be answerable without a database backup.
 */
export const kbArticleRevisions = pgTable(
  'kb_article_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => kbArticles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    body: text('body').notNull(),
    keywords: text('keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: kbArticleStatus('status').notNull(),
    visibility: kbArticleVisibility('visibility').notNull(),
    editedByUserId: uuid('edited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('kb_article_revisions_version_unique').on(table.articleId, table.version),
    index('kb_article_revisions_article_idx').on(table.articleId, table.version.desc()),
  ],
);

/**
 * "Did this answer your question?" — the only signal that distinguishes an
 * article people keep opening because it helps from one they keep opening
 * because the title lies.
 *
 * One vote per user per article, enforced by the unique constraint. Anonymous
 * votes are allowed to repeat, because nulls are distinct in Postgres and there
 * is nothing honest to key them on.
 */
export const kbArticleFeedback = pgTable(
  'kb_article_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => kbArticles.id, { onDelete: 'cascade' }),
    helpful: boolean('helpful').notNull(),
    comment: text('comment'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    /** The ticket the reader was working when they voted, when there was one. */
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('kb_article_feedback_user_unique').on(table.articleId, table.userId),
    index('kb_article_feedback_article_idx').on(table.articleId, table.createdAt.desc()),
  ],
);

/**
 * One row per read, with the route the reader took to get there.
 *
 * The counter on the article answers "how popular"; this table answers "through
 * which door", which is the question deflection turns on — an article opened
 * from `suggest` during ticket creation is doing different work from the same
 * article opened by an agent mid-call.
 */
export const kbViews = pgTable(
  'kb_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => kbArticles.id, { onDelete: 'cascade' }),
    source: kbViewSource('source').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('kb_views_article_idx').on(table.articleId, table.createdAt.desc()),
    // The reporting view groups by day and source across the whole table.
    index('kb_views_created_idx').on(table.createdAt.desc()),
  ],
);

export type KbArticleRow = typeof kbArticles.$inferSelect;
export type NewKbArticle = typeof kbArticles.$inferInsert;
export type KbArticleRevisionRow = typeof kbArticleRevisions.$inferSelect;
export type KbArticleFeedbackRow = typeof kbArticleFeedback.$inferSelect;
export type KbViewRow = typeof kbViews.$inferSelect;
export type KbArticleStatus = (typeof kbArticleStatus.enumValues)[number];
export type KbArticleVisibility = (typeof kbArticleVisibility.enumValues)[number];
export type KbViewSource = (typeof kbViewSource.enumValues)[number];
