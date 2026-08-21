import { AppError } from '../../common/errors/index.js';
import { isUserActor, type Actor } from '../../common/types/actor.js';
import { env } from '../../config/index.js';
import { withTransaction } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as auditService from '../audit/audit.service.js';
import * as categoryService from '../category/category.service.js';
import * as productService from '../product/product.service.js';
import type { KbArticleRow, KbArticleStatus, KbArticleVisibility } from './knowledge-base.model.js';
import * as repository from './knowledge-base.repository.js';
import { toSearchQuery, toSuggestQuery } from './knowledge-base.search.js';
import type {
  ArticleHit,
  ArticleView,
  KbArticleFeedbackRow,
  KbArticleRevisionRow,
  KbViewSource,
  ListArticlesFilter,
} from './knowledge-base.types.js';

const log = createModuleLogger('knowledge-base');

/** Legal transitions. `published` is reachable only through `publish`. */
const TRANSITIONS: Record<KbArticleStatus, readonly KbArticleStatus[]> = {
  draft: ['in_review', 'archived'],
  in_review: ['draft', 'archived'],
  published: ['draft', 'in_review', 'archived'],
  archived: ['draft'],
};

async function scopedProductIds(actor: Actor): Promise<string[] | null> {
  const scope = await productService.scopeFor(actor);
  return scope.kind === 'all' ? null : scope.productIds;
}

/**
 * Whether this actor may be shown agent-only articles.
 *
 * Only a signed-in member of staff. An API key belongs to a product system —
 * the mobile app, the web portal — which is a customer-facing surface however
 * the key was issued, and internal articles are fraud procedure and escalation
 * contacts. The permission is not enough on its own; the actor kind is the gate.
 */
function mayReadInternal(actor: Actor): boolean {
  return isUserActor(actor) || actor.kind === 'system';
}

// -- reads -------------------------------------------------------------------

export async function list(
  filter: ListArticlesFilter,
  actor: Actor,
): Promise<{ items: ArticleView[]; hasMore: boolean }> {
  if (filter.productId) await productService.assertAccess(actor, filter.productId);

  const rows = await repository.list(
    { ...filter, limit: filter.limit + 1 },
    await scopedProductIds(actor),
  );

  const hasMore = rows.length > filter.limit;
  const page = (hasMore ? rows.slice(0, filter.limit) : rows) as ArticleView[];

  return {
    items: page.filter((article) => mayReadInternal(actor) || article.visibility === 'public'),
    hasMore,
  };
}

/**
 * One article, by id or slug, counted as a read.
 *
 * The view is recorded here rather than in the controller so every route that
 * hands an article to a reader contributes to the same number — the counter is
 * only worth anything if it cannot be bypassed by adding an endpoint.
 */
export async function read(
  ref: string,
  actor: Actor,
  context: { source: KbViewSource; ticketId?: string | undefined },
): Promise<ArticleView> {
  const article = await resolve(ref);

  if (article.productId) await productService.assertAccess(actor, article.productId);

  // 404 rather than 403: whether an internal runbook exists is itself
  // information, and the same reasoning as ticket product scoping applies.
  if (article.visibility === 'internal' && !mayReadInternal(actor)) {
    throw AppError.notFound('Article not found');
  }
  if (article.status !== 'published' && !mayReadInternal(actor)) {
    throw AppError.notFound('Article not found');
  }

  await repository.recordView({
    articleId: article.id,
    source: context.source,
    userId: isUserActor(actor) ? actor.id : null,
    ticketId: context.ticketId ?? null,
  });

  return { ...article, viewCount: article.viewCount + 1 };
}

async function resolve(ref: string): Promise<ArticleView> {
  const byId = isUuid(ref) ? await repository.findById(ref) : undefined;
  const article = byId ?? (await repository.findBySlug(ref));

  if (!article) throw AppError.notFound('Article not found');
  return article;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Management read: no view recorded, and the caller must hold `kb:manage`. */
async function requireManageable(id: string, actor: Actor): Promise<KbArticleRow> {
  const article = await repository.findRawById(id);
  if (!article) throw AppError.notFound('Article not found');

  if (article.productId) await productService.assertAccess(actor, article.productId);
  return article;
}

// -- search ------------------------------------------------------------------

export async function search(
  input: {
    q: string;
    productId?: string | undefined;
    categoryId?: string | undefined;
    includeInternal: boolean;
    limit: number;
  },
  actor: Actor,
): Promise<ArticleHit[]> {
  if (input.productId) await productService.assertAccess(actor, input.productId);

  const query = toSearchQuery(input.q);
  // Nothing searchable is an empty result, never an unfiltered one.
  if (!query) return [];

  const hits = await repository.search(query, {
    productIds: await scopedProductIds(actor),
    productId: input.productId,
    categoryId: input.categoryId,
    includeInternal: input.includeInternal && mayReadInternal(actor),
    limit: input.limit,
  });

  await recordViews(hits, 'search', actor, undefined);
  return hits;
}

/**
 * Articles that might answer a query before it becomes a ticket.
 *
 * Public and published only, unconditionally — not "unless the caller holds a
 * permission". This is the one endpoint whose entire purpose is to put text in
 * front of a customer, and an internal runbook reaching it would be a data
 * breach dressed up as a feature.
 *
 * An empty result is a normal outcome: "hello please help" contains nothing to
 * suggest from, and an arbitrary article is worse than none.
 */
export async function suggest(
  input: {
    subject?: string | undefined;
    body?: string | undefined;
    productId?: string | undefined;
    ticketId?: string | undefined;
    limit?: number | undefined;
  },
  actor: Actor,
): Promise<ArticleHit[]> {
  if (input.productId) await productService.assertAccess(actor, input.productId);

  const query = toSuggestQuery(input);
  if (!query) return [];

  const hits = await repository.search(query, {
    productIds: await scopedProductIds(actor),
    productId: input.productId,
    includeInternal: false,
    limit: input.limit ?? env.KB_SUGGEST_LIMIT,
  });

  await recordViews(hits, 'suggest', actor, input.ticketId);
  return hits;
}

/**
 * Records that these articles were put in front of a reader.
 *
 * A result list is an impression, not a read, and the two are worth
 * distinguishing — but not at the price of a second table. `source` carries the
 * difference: a `suggest` row means "offered during ticket creation", a `direct`
 * row means "actually opened", and the gap between the two counts is the
 * deflection rate.
 */
async function recordViews(
  hits: ArticleHit[],
  source: KbViewSource,
  actor: Actor,
  ticketId: string | undefined,
): Promise<void> {
  for (const hit of hits) {
    try {
      await repository.recordView({
        articleId: hit.id,
        source,
        userId: isUserActor(actor) ? actor.id : null,
        ticketId: ticketId ?? null,
      });
    } catch (error) {
      // Analytics must never fail a search.
      log.error('failed to record kb view', { articleId: hit.id, err: error });
    }
  }
}

// -- writes ------------------------------------------------------------------

export async function create(
  input: {
    title: string;
    summary?: string | null | undefined;
    body: string;
    keywords?: string[] | undefined;
    productId?: string | null | undefined;
    categoryId?: string | null | undefined;
    visibility: KbArticleVisibility;
  },
  actor: Actor,
): Promise<ArticleView> {
  if (input.productId) {
    await productService.requireById(input.productId);
    await productService.assertAccess(actor, input.productId);
  }
  if (input.categoryId) {
    await assertCategoryFits(input.categoryId, input.productId ?? null);
  }

  const article = await withTransaction(async ({ tx }) => {
    const row = await repository.insert(
      {
        slug: await uniqueSlug(input.title),
        title: input.title,
        summary: input.summary ?? null,
        body: input.body,
        keywords: input.keywords ?? [],
        productId: input.productId ?? null,
        categoryId: input.categoryId ?? null,
        visibility: input.visibility,
        status: 'draft',
        authorUserId: isUserActor(actor) ? actor.id : null,
        lastEditedByUserId: isUserActor(actor) ? actor.id : null,
      },
      tx,
    );

    await auditService.record(
      {
        action: 'kb_article.created',
        entityType: 'kb_article',
        entityId: row.id,
        after: { slug: row.slug, title: row.title, visibility: row.visibility },
      },
      actor,
      tx,
    );

    return row;
  });

  log.info('kb article created', { articleId: article.id, slug: article.slug });
  return (await repository.findById(article.id)) as ArticleView;
}

/**
 * Edits an article, snapshotting what it said before.
 *
 * The revision is written from the *current* row inside the same transaction as
 * the update, so the history can never be missing an entry that the article's
 * version number claims exists.
 *
 * An edit to a published article leaves it published. Sending it back to draft
 * on every typo fix would mean a correction takes the answer offline, which is
 * the opposite of what a correction is for.
 */
export async function update(
  id: string,
  patch: {
    title?: string | undefined;
    summary?: string | null | undefined;
    body?: string | undefined;
    keywords?: string[] | undefined;
    productId?: string | null | undefined;
    categoryId?: string | null | undefined;
    visibility?: KbArticleVisibility | undefined;
    /** `published` is refused here by the state machine, with a pointer. */
    status?: KbArticleStatus | undefined;
  },
  actor: Actor,
): Promise<ArticleView> {
  const before = await requireManageable(id, actor);

  if (patch.productId) {
    await productService.requireById(patch.productId);
    await productService.assertAccess(actor, patch.productId);
  }
  if (patch.categoryId) {
    const productId = patch.productId ?? before.productId;
    await assertCategoryFits(patch.categoryId, productId);
  }
  if (patch.status) assertTransition(before.status, patch.status);

  await withTransaction(async ({ tx }) => {
    await repository.insertRevision(
      {
        articleId: before.id,
        version: before.version,
        title: before.title,
        summary: before.summary,
        body: before.body,
        keywords: before.keywords,
        status: before.status,
        visibility: before.visibility,
        editedByUserId: isUserActor(actor) ? actor.id : null,
      },
      tx,
    );

    const row = await repository.update(
      id,
      {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.keywords !== undefined ? { keywords: patch.keywords } : {}),
        ...(patch.productId !== undefined ? { productId: patch.productId } : {}),
        ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        version: before.version + 1,
        lastEditedByUserId: isUserActor(actor) ? actor.id : null,
      },
      tx,
    );
    if (!row) throw AppError.notFound('Article not found');

    await auditService.record(
      {
        action: 'kb_article.updated',
        entityType: 'kb_article',
        entityId: id,
        before: {
          title: before.title,
          status: before.status,
          visibility: before.visibility,
          version: before.version,
        },
        after: {
          title: row.title,
          status: row.status,
          visibility: row.visibility,
          version: row.version,
        },
      },
      actor,
      tx,
    );
  });

  return (await repository.findById(id)) as ArticleView;
}

/**
 * Publishes an article, which is what makes it answerable to a customer.
 *
 * Its own endpoint rather than `PATCH { status: 'published' }` because it is a
 * different decision from an edit: it needs its own permission story, its own
 * audit action, and — as the reviewer of copy about a financial product — a
 * place to refuse a body that is still a placeholder.
 */
export async function publish(id: string, actor: Actor): Promise<ArticleView> {
  const before = await requireManageable(id, actor);

  if (before.status === 'published') {
    throw AppError.conflict('That article is already published');
  }

  // A published article is what a customer is shown; an empty one is worse than
  // no article, because it looks like an answer.
  if (before.body.trim().length < 20) {
    throw AppError.validation('An article needs a body before it can be published', {
      details: [{ field: 'body', issue: 'too short to answer anything' }],
    });
  }

  const now = new Date();

  await withTransaction(async ({ tx }) => {
    const row = await repository.update(
      id,
      {
        status: 'published',
        publishedAt: before.publishedAt ?? now,
        publishedByUserId: isUserActor(actor) ? actor.id : null,
      },
      tx,
    );
    if (!row) throw AppError.notFound('Article not found');

    await auditService.record(
      {
        action: 'kb_article.published',
        entityType: 'kb_article',
        entityId: id,
        before: { status: before.status },
        after: { status: row.status, visibility: row.visibility },
      },
      actor,
      tx,
    );
  });

  log.info('kb article published', {
    articleId: id,
    slug: before.slug,
    visibility: before.visibility,
  });

  return (await repository.findById(id)) as ArticleView;
}

function assertTransition(from: KbArticleStatus, to: KbArticleStatus): void {
  if (from === to) return;

  if (!TRANSITIONS[from].includes(to)) {
    throw AppError.validation(`An article cannot go from ${from} to ${to}`, {
      details: [
        {
          field: 'status',
          issue:
            to === 'published'
              ? 'use POST /kb/articles/:id/publish'
              : `allowed: ${TRANSITIONS[from].join(', ')}`,
        },
      ],
    });
  }
}

/**
 * A category belongs to one product, so an article can only carry a category
 * from its own product — or no category at all, if it applies everywhere.
 */
async function assertCategoryFits(categoryId: string, productId: string | null): Promise<void> {
  if (!productId) {
    throw AppError.validation('An article with a category must belong to a product', {
      details: [{ field: 'productId', issue: 'a category is scoped to one product' }],
    });
  }

  await categoryService.requireForProduct(categoryId, productId);
}

/**
 * A slug from the title, with a numeric suffix if it is taken.
 *
 * Generated once, on creation, and never recomputed: a slug is in the links
 * agents paste into tickets, and rewriting it on a title fix would break every
 * one of them.
 */
async function uniqueSlug(title: string): Promise<string> {
  const base =
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'article';

  if (!(await repository.slugExists(base))) return base;

  for (let suffix = 2; suffix <= 50; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!(await repository.slugExists(candidate))) return candidate;
  }

  // Fifty articles with the same title is not a naming collision, it is a
  // mistake, but the write must still succeed.
  return `${base}-${Date.now().toString(36)}`;
}

// -- feedback ----------------------------------------------------------------

/**
 * Records "did this help".
 *
 * One vote per person: changing your mind moves the counters rather than adding
 * a second opinion, which is what keeps the helpfulness ratio meaningful.
 */
export async function recordFeedback(
  ref: string,
  input: { helpful: boolean; comment?: string | undefined; ticketId?: string | undefined },
  actor: Actor,
): Promise<ArticleView> {
  const article = await resolve(ref);
  if (article.productId) await productService.assertAccess(actor, article.productId);

  if (article.visibility === 'internal' && !mayReadInternal(actor)) {
    throw AppError.notFound('Article not found');
  }

  const { previous } = await repository.upsertFeedback({
    articleId: article.id,
    helpful: input.helpful,
    comment: input.comment ?? null,
    userId: isUserActor(actor) ? actor.id : null,
    ticketId: input.ticketId ?? null,
  });

  // An unchanged vote moves nothing; a changed one moves both counters.
  if (previous === input.helpful) {
    return (await repository.findById(article.id)) as ArticleView;
  }

  await repository.adjustCounters(article.id, {
    ...(input.helpful ? { helpful: 1 } : { notHelpful: 1 }),
    ...(previous === null ? {} : previous ? { helpful: -1 } : { notHelpful: -1 }),
  });

  return (await repository.findById(article.id)) as ArticleView;
}

export async function listFeedback(
  id: string,
  limit: number,
  actor: Actor,
): Promise<KbArticleFeedbackRow[]> {
  await requireManageable(id, actor);
  return repository.listFeedback(id, limit);
}

export async function listRevisions(
  id: string,
  limit: number,
  actor: Actor,
): Promise<KbArticleRevisionRow[]> {
  await requireManageable(id, actor);
  return repository.listRevisions(id, limit);
}

/** Article counts by status, for the reporting overview. */
export function countByStatus() {
  return repository.countByStatus();
}
