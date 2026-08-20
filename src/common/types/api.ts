import type { ErrorCode, ErrorDetail } from '../errors/index.js';

export interface PaginationMeta {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ResponseMeta {
  requestId: string;
  pagination?: PaginationMeta;
  [key: string]: unknown;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta: ResponseMeta;
}

export interface ApiFailure {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
  };
  meta: ResponseMeta;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface Paginated<T> {
  items: T[];
  pagination: PaginationMeta;
}
