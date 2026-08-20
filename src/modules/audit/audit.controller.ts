import type { Request, Response } from 'express';
import { sendSuccess } from '../../common/utils/response.js';
import * as auditService from './audit.service.js';
import type { ListAuditLogsQuery } from './audit.schema.js';

export async function listAuditLogs(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListAuditLogsQuery;

  // One extra row tells us whether another page exists without a count query.
  const rows = await auditService.list({ ...query, limit: query.limit + 1 });
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;

  sendSuccess(res, items, {
    pagination: {
      limit: query.limit,
      hasMore,
      nextCursor: hasMore ? (items.at(-1)?.createdAt.toISOString() ?? null) : null,
    },
  });
}
