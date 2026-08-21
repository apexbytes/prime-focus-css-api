import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { categories } from '../category/category.model.js';
import { products } from '../product/product.model.js';
import {
  KB_SEARCH_CONFIG,
  kbArticleFeedback,
  kbArticleRevisions,
  kbArticles,
  kbViews,
  type KbArticleFeedbackRow,
  type KbArticleRevisionRow,
  type KbArticleRow,
  type KbArticleStatus,
  type NewKbArticle,
} from './knowledge-base.model.js';
import type { ArticleHit, ListArticlesFilter, SearchOptions } from './knowledge-base.types.js';

/**
 * Everything but `search_vector`, which is a Postgres-maintained column the size
 * of the article body and of no use to any caller.
 */
const articleColumns = {
  id: kbArticles.id,
  slug: kbArticles.slug,
  productId: kbArticles.productId,
  productName: products.name,
  categoryId: kbArticles.categoryId,
  categoryName: categories.name,
  title: kbArticles.title,
  summary: kbArticles.summary,
  body: kbArticles.body,
  keywords: kbArticles.keywords,
  status: kbArticles.status,
  visibility: kbArticles.visibility,
  authorUserId: kbArticles.authorUserId,
  lastEditedByUserId: kbArticles.lastEditedByUserId,
  publishedAt: kbArticles.publishedAt,
  version: kbArticles.version,
  viewCount: kbArticles.viewCount,
  helpfulCount: kbArticles.helpfulCount,
  notHelpfulCount: kbArticles.notHelpfulCount,
  createdAt: kbArticles.createdAt,
  updatedAt: kbArticles.updatedAt,
};

function baseQuery(exec: Executor) {
  return exec
    .select(articleColumns)
    .from(kbArticles)
    .leftJoin(products, eq(products.id, kbArticles.productId))
    .leftJoin(categories, eq(categories.id, kbArticles.categoryId));
}

/**
 * The caller's product scope, as a condition.
 *
 * An article with no product applies everywhere, so it is visible to every
 * scope — that is the point of the null. An empty grant list still matches only
 * those: no grants means no product-specific article, not every article.
 */
function scopeCondition(productIds: string[] | null): SQL | undefined {
  if (productIds === null) return undefined;

  return productIds.length === 0
    ? isNull(kbArticles.productId)
    : or(isNull(kbArticles.productId), inArray(kbArticles.productId, productIds));
}

export function list(filter: ListArticlesFilter, productIds: string[] | null, exec: Executor = db) {
  const conditions = [
    scopeCondition(productIds),
    filter.productId ? eq(kbArticles.productId, filter.productId) : undefined,
    filter.categoryId ? eq(kbArticles.categoryId, filter.categoryId) : undefined,
    filter.status ? eq(kbArticles.status, filter.status) : undefined,
    filter.visibility ? eq(kbArticles.visibility, filter.visibility) : undefined,
    filter.search ? sql`${kbArticles.title} ilike ${`%${filter.search}%`}` : undefined,
    // Keyset pagination on the same descending order the query is sorted by.
    filter.cursor ? lt(kbArticles.updatedAt, new Date(filter.cursor)) : undefined,
  ].filter((condition) => condition !== undefined);

  return baseQuery(exec)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(kbArticles.updatedAt))
    .limit(filter.limit);
}

export async function findById(id: string, exec: Executor = db) {
  const [row] = await baseQuery(exec).where(eq(kbArticles.id, id)).limit(1);
  return row;
}

export async function findBySlug(slug: string, exec: Executor = db) {
  const [row] = await baseQuery(exec).where(eq(kbArticles.slug, slug)).limit(1);
  return row;
}

export async function findRawById(
  id: string,
  exec: Executor = db,
): Promise<KbArticleRow | undefined> {
  const [row] = await exec.select().from(kbArticles).where(eq(kbArticles.id, id)).limit(1);
  return row;
}

export async function slugExists(slug: string, exec: Executor = db): Promise<boolean> {
  const [row] = await exec
    .select({ id: kbArticles.id })
    .from(kbArticles)
    .where(eq(kbArticles.slug, slug))
    .limit(1);

  return row !== undefined;
}

export async function insert(values: NewKbArticle, exec: Executor = db): Promise<KbArticleRow> {
  const [row] = await exec.insert(kbArticles).values(values).returning();
  if (!row) throw new Error('kb article insert returned no row');
  return row;
}

export async function update(
  id: string,
  patch: Partial<KbArticleRow>,
  exec: Executor = db,
): Promise<KbArticleRow | undefined> {
  const [row] = await exec.update(kbArticles).set(patch).where(eq(kbArticles.id, id)).returning();
  return row;
}

// -- search ------------------------------------------------------------------

/**
 * Ranked full-text search.
 *
 * Written as one statement rather than a query-builder chain because the query
 * appears four times — in the match, the rank, the headline and the ordering —
 * and drizzle's builder cannot express `ts_headline` at all. `websearch_to_tsquery`
 * is the parser that cannot throw on arbitrary input, which is what makes it
 * safe to hand a search box straight to.
 *
 * `ts_rank_cd` rather than `ts_rank`: cover density rewards an article where the
 * terms appear near each other, which on a corpus of short support articles is a
 * better proxy for relevance than raw term frequency.
 */
export async function search(
  query: string,
  options: SearchOptions,
  exec: Executor = db,
): Promise<ArticleHit[]> {
  const scope = options.productIds;
  const scopeFilter =
    scope === null
      ? sql`true`
      : scope.length === 0
        ? sql`a.product_id is null`
        : // `sql.param` matters: interpolating an array into a template spreads it
          // into one placeholder per element, so `any($1)` would receive a single
          // uuid and Postgres would reject it as a malformed array literal.
          sql`(a.product_id is null or a.product_id = any(${sql.param(scope)}::uuid[]))`;

  // Unpublished and internal articles are excluded in SQL, not in the caller.
  // A deflection endpoint that filtered in TypeScript would be one early
  // `return` away from emailing a fraud runbook to a customer.
  const visibilityFilter = options.includeInternal
    ? sql`a.status = 'published'`
    : sql`a.status = 'published' and a.visibility = 'public'`;

  const rows = await exec.execute(sql`
    with q as (select websearch_to_tsquery(${KB_SEARCH_CONFIG}, ${query}) as tsq)
    select
      a.id,
      a.slug,
      a.title,
      a.summary,
      a.product_id      as "productId",
      a.category_id     as "categoryId",
      a.visibility,
      a.helpful_count   as "helpfulCount",
      a.not_helpful_count as "notHelpfulCount",
      ts_rank_cd(a.search_vector, q.tsq)::float8 as rank,
      ts_headline(${KB_SEARCH_CONFIG}, a.body, q.tsq,
        'MaxFragments=2, MaxWords=28, MinWords=8, ShortWord=3, StartSel=<mark>, StopSel=</mark>'
      ) as excerpt
    from kb_articles a, q
    where a.search_vector @@ q.tsq
      and ${visibilityFilter}
      and ${scopeFilter}
      and (${options.productId ?? null}::uuid is null or a.product_id = ${options.productId ?? null}::uuid)
      and (${options.categoryId ?? null}::uuid is null or a.category_id = ${options.categoryId ?? null}::uuid)
    order by rank desc, a.helpful_count desc, a.published_at desc nulls last
    limit ${options.limit}
  `);

  return rows.rows as unknown as ArticleHit[];
}

// -- revisions ---------------------------------------------------------------

export async function insertRevision(
  values: typeof kbArticleRevisions.$inferInsert,
  exec: Executor = db,
): Promise<KbArticleRevisionRow> {
  const [row] = await exec.insert(kbArticleRevisions).values(values).returning();
  if (!row) throw new Error('kb revision insert returned no row');
  return row;
}

export function listRevisions(
  articleId: string,
  limit: number,
  exec: Executor = db,
): Promise<KbArticleRevisionRow[]> {
  return exec
    .select()
    .from(kbArticleRevisions)
    .where(eq(kbArticleRevisions.articleId, articleId))
    .orderBy(desc(kbArticleRevisions.version))
    .limit(limit);
}

// -- feedback ----------------------------------------------------------------

/**
 * Records a vote, replacing the voter's previous one.
 *
 * Returns the row it wrote plus what it replaced, because the counters on the
 * article are denormalised: changing a vote from helpful to not has to move both
 * counters, and only the caller knows which way.
 */
export async function upsertFeedback(
  values: typeof kbArticleFeedback.$inferInsert,
  exec: Executor = db,
): Promise<{ row: KbArticleFeedbackRow; previous: boolean | null }> {
  const previous = values.userId
    ? await findFeedbackByUser(values.articleId, values.userId, exec)
    : undefined;

  const [row] = await exec
    .insert(kbArticleFeedback)
    .values(values)
    .onConflictDoUpdate({
      target: [kbArticleFeedback.articleId, kbArticleFeedback.userId],
      set: {
        helpful: values.helpful,
        comment: values.comment ?? null,
        ticketId: values.ticketId ?? null,
        createdAt: new Date(),
      },
    })
    .returning();

  if (!row) throw new Error('kb feedback upsert returned no row');
  return { row, previous: previous?.helpful ?? null };
}

async function findFeedbackByUser(
  articleId: string,
  userId: string,
  exec: Executor = db,
): Promise<KbArticleFeedbackRow | undefined> {
  const [row] = await exec
    .select()
    .from(kbArticleFeedback)
    .where(and(eq(kbArticleFeedback.articleId, articleId), eq(kbArticleFeedback.userId, userId)))
    .limit(1);

  return row;
}

export function listFeedback(
  articleId: string,
  limit: number,
  exec: Executor = db,
): Promise<KbArticleFeedbackRow[]> {
  return exec
    .select()
    .from(kbArticleFeedback)
    .where(eq(kbArticleFeedback.articleId, articleId))
    .orderBy(desc(kbArticleFeedback.createdAt))
    .limit(limit);
}

/** Moves the denormalised counters by a signed delta. */
export async function adjustCounters(
  id: string,
  delta: { helpful?: number; notHelpful?: number },
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(kbArticles)
    .set({
      ...(delta.helpful
        ? { helpfulCount: sql`greatest(0, ${kbArticles.helpfulCount} + ${delta.helpful})` }
        : {}),
      ...(delta.notHelpful
        ? {
            notHelpfulCount: sql`greatest(0, ${kbArticles.notHelpfulCount} + ${delta.notHelpful})`,
          }
        : {}),
    })
    .where(eq(kbArticles.id, id));
}

// -- views -------------------------------------------------------------------

/**
 * Records a read and bumps the counter.
 *
 * Two statements rather than a trigger: the counter is a cache of this table,
 * and a reader who wants to know why a number moved should be able to find the
 * code that moved it.
 */
export async function recordView(
  values: typeof kbViews.$inferInsert,
  exec: Executor = db,
): Promise<void> {
  await exec.insert(kbViews).values(values);
  await exec
    .update(kbArticles)
    .set({ viewCount: sql`${kbArticles.viewCount} + 1` })
    .where(eq(kbArticles.id, values.articleId));
}

export function countByStatus(exec: Executor = db) {
  return exec
    .select({ status: kbArticles.status, count: sql<number>`count(*)::int` })
    .from(kbArticles)
    .groupBy(kbArticles.status);
}

export type { KbArticleStatus };
