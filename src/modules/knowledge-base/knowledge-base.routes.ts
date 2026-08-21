import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  createArticle,
  getArticle,
  listArticles,
  listFeedback,
  listRevisions,
  publishArticle,
  searchArticles,
  submitFeedback,
  suggestArticles,
  updateArticle,
} from './knowledge-base.controller.js';
import {
  articleRefParams,
  createArticleBody,
  feedbackBody,
  idParams,
  listArticlesQuery,
  revisionsQuery,
  searchQuery,
  suggestQuery,
  updateArticleBody,
} from './knowledge-base.schema.js';

/**
 * Mounted at /kb.
 *
 * Reading is `kb:read`, which every role holds — an agent who cannot read the
 * knowledge base cannot do the job. Writing and publishing are `kb:manage`,
 * held by tier-2 and above, because a published article is copy about a
 * financial product going out under the company's name.
 */
export const kbRouter: Router = Router();

kbRouter.use(authenticate);

// Before '/articles/:id', so the literal paths win over the parameter.
kbRouter.get(
  '/search',
  requirePermission('kb:read'),
  validate({ query: searchQuery }),
  searchArticles,
);

kbRouter.get(
  '/suggest',
  requirePermission('kb:read'),
  validate({ query: suggestQuery }),
  suggestArticles,
);

kbRouter.get(
  '/articles',
  requirePermission('kb:read'),
  validate({ query: listArticlesQuery }),
  listArticles,
);

kbRouter.post(
  '/articles',
  requirePermission('kb:manage'),
  validate({ body: createArticleBody }),
  createArticle,
);

// A slug is accepted as well as an id: a KB link pasted into a ticket is a slug.
kbRouter.get(
  '/articles/:id',
  requirePermission('kb:read'),
  validate({ params: articleRefParams }),
  getArticle,
);

kbRouter.patch(
  '/articles/:id',
  requirePermission('kb:manage'),
  validate({ params: idParams, body: updateArticleBody }),
  updateArticle,
);

kbRouter.post(
  '/articles/:id/publish',
  requirePermission('kb:manage'),
  validate({ params: idParams }),
  publishArticle,
);

// `kb:read`, not `kb:manage`: the point of the vote is that the reader casts it.
kbRouter.post(
  '/articles/:id/feedback',
  requirePermission('kb:read'),
  validate({ params: articleRefParams, body: feedbackBody }),
  submitFeedback,
);

kbRouter.get(
  '/articles/:id/feedback',
  requirePermission('kb:manage'),
  validate({ params: idParams, query: revisionsQuery }),
  listFeedback,
);

kbRouter.get(
  '/articles/:id/revisions',
  requirePermission('kb:manage'),
  validate({ params: idParams, query: revisionsQuery }),
  listRevisions,
);
