import type { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { sendSuccess } from '../../common/utils/response.js';
import { getLiveness, getReadiness } from './health.service.js';

export function liveness(_req: Request, res: Response): void {
  sendSuccess(res, getLiveness());
}

export async function readiness(_req: Request, res: Response, next: NextFunction): Promise<void> {
  const report = await getReadiness();

  if (report.status !== 'ok') {
    // 503 with the failing dependencies named, so an on-call engineer can read
    // the probe output and know which dependency to look at.
    next(
      new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, 'Service is not ready to accept traffic', {
        details: report.shuttingDown
          ? [{ field: 'process', issue: 'shutting down' }]
          : report.dependencies
              .filter((dependency) => dependency.state === 'unavailable')
              .map((dependency) => ({
                field: dependency.name,
                issue: dependency.error ?? 'unavailable',
              })),
        context: { dependencies: report.dependencies },
      }),
    );
    return;
  }

  sendSuccess(res, report);
}
