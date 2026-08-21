import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendSuccess } from '../../common/utils/response.js';
import * as kbService from './knowledge-base.service.js';
import type {
  CreateArticleBody,
  FeedbackBody,
  ListArticlesQuery,
  RevisionsQuery,
  SearchQuery,
  SuggestQuery,
  UpdateArticleBody,
} from './knowledge-base.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listArticles(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListArticlesQuery;

  const { items, hasMore } = await kbService.list(
    {
      productId: query.productId,
      categoryId: query.categoryId,
      status: query.status,
      visibility: query.visibility,
      search: query.q,
      limit: query.limit,
      cursor: query.cursor,
    },
    actorOf(req),
  );

  sendSuccess(res, items, {
    pagination: {
      limit: query.limit,
      hasMore,
      // Keyset cursor: where the next page starts, not a page number.
      nextCursor: hasMore ? (items.at(-1)?.updatedAt.toISOString() ?? null) : null,
    },
  });
}

export async function getArticle(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await kbService.read(req.params.id as string, actorOf(req), { source: 'direct' }),
  );
}

export async function createArticle(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await kbService.create(req.body as CreateArticleBody, actorOf(req)), {
    status: 201,
  });
}

export async function updateArticle(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await kbService.update(req.params.id as string, req.body as UpdateArticleBody, actorOf(req)),
  );
}

export async function publishArticle(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await kbService.publish(req.params.id as string, actorOf(req)));
}

export async function searchArticles(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as SearchQuery;

  sendSuccess(
    res,
    await kbService.search(
      {
        q: query.q,
        productId: query.productId,
        categoryId: query.categoryId,
        includeInternal: query.includeInternal,
        limit: query.limit,
      },
      actorOf(req),
    ),
  );
}

/**
 * Deflection: what might already answer this, asked while the customer is still
 * typing. Always 200 with a list, possibly empty — a caller in the middle of a
 * ticket-creation form must never be handed an error by an optional lookup.
 */
export async function suggestArticles(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as SuggestQuery;
  sendSuccess(res, await kbService.suggest(query, actorOf(req)));
}

export async function submitFeedback(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await kbService.recordFeedback(req.params.id as string, req.body as FeedbackBody, actorOf(req)),
    { status: 201 },
  );
}

export async function listFeedback(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as RevisionsQuery;
  sendSuccess(
    res,
    await kbService.listFeedback(req.params.id as string, query.limit, actorOf(req)),
  );
}

export async function listRevisions(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as RevisionsQuery;
  sendSuccess(
    res,
    await kbService.listRevisions(req.params.id as string, query.limit, actorOf(req)),
  );
}
