import type {
  KbArticleFeedbackRow,
  KbArticleRevisionRow,
  KbArticleRow,
  KbArticleStatus,
  KbArticleVisibility,
  KbViewSource,
} from './knowledge-base.model.js';

/**
 * An article as the API returns it.
 *
 * `searchVector` is deliberately absent: it is a Postgres implementation detail
 * the size of the article body, and shipping it would double every response for
 * nothing.
 */
export interface ArticleView {
  id: string;
  slug: string;
  productId: string | null;
  productName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  title: string;
  summary: string | null;
  body: string;
  keywords: string[];
  status: KbArticleStatus;
  visibility: KbArticleVisibility;
  authorUserId: string | null;
  lastEditedByUserId: string | null;
  publishedAt: Date | null;
  version: number;
  viewCount: number;
  helpfulCount: number;
  notHelpfulCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A search hit. Carries no body — a result list shows a headline and a snippet,
 * and returning ten full articles to draw ten snippets is waste.
 */
export interface ArticleHit {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  productId: string | null;
  categoryId: string | null;
  visibility: KbArticleVisibility;
  helpfulCount: number;
  notHelpfulCount: number;
  /** `ts_rank_cd` against the query; comparable only within one result set. */
  rank: number;
  /** `ts_headline` over the body, with the matched terms marked. */
  excerpt: string;
}

export interface ListArticlesFilter {
  productId?: string | undefined;
  categoryId?: string | undefined;
  status?: KbArticleStatus | undefined;
  visibility?: KbArticleVisibility | undefined;
  search?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface SearchOptions {
  /** Null means every product, for a caller whose scope is unrestricted. */
  productIds: string[] | null;
  productId?: string | undefined;
  categoryId?: string | undefined;
  /** Only `published` + `public` articles when false, whatever the caller holds. */
  includeInternal: boolean;
  limit: number;
}

export type { KbArticleFeedbackRow, KbArticleRevisionRow, KbArticleRow, KbViewSource };
export type { KbArticleStatus, KbArticleVisibility };
