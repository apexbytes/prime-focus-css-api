import type { NextFunction, Request, Response } from 'express';
import { OPERATIONAL_PATHS } from '../../config/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';

const log = createModuleLogger('http');

function levelFor(
  statusCode: number,
  isOperationalPath: boolean,
): 'error' | 'warn' | 'info' | 'debug' {
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return isOperationalPath ? 'debug' : 'info';
}

/**
 * One line per completed request. Logs the matched route rather than the raw URL
 * where possible, and only the *names* of query parameters — values can carry
 * customer identifiers.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    const isOperationalPath = (OPERATIONAL_PATHS as readonly string[]).includes(req.path);
    // `req.route` is typed as `any` by @types/express.
    const route = req.route as { path?: string } | undefined;
    const durationMs = Math.round((performance.now() - req.startedAt) * 100) / 100;

    log.log(levelFor(res.statusCode, isOperationalPath), 'request completed', {
      method: req.method,
      path: route?.path ? `${req.baseUrl}${route.path}` : req.path,
      status: res.statusCode,
      durationMs,
      queryKeys: Object.keys(req.query),
      ip: req.ip,
      userAgent: req.get('user-agent'),
      contentLength: res.getHeader('content-length'),
    });
  });

  next();
}
