import type { Response } from 'express';
import type { ApiSuccess, PaginationMeta, ResponseMeta } from '../types/api.js';

interface SendOptions {
  status?: number;
  pagination?: PaginationMeta;
  meta?: Record<string, unknown>;
}

/** The only way a controller should write a success body. */
export function sendSuccess<T>(res: Response, data: T, options: SendOptions = {}): void {
  const meta: ResponseMeta = {
    requestId: res.req.requestId,
    ...(options.pagination ? { pagination: options.pagination } : {}),
    ...options.meta,
  };

  const body: ApiSuccess<T> = { success: true, data, meta };
  res.status(options.status ?? 200).json(body);
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}
