import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/index.js';

/** Mounted after every route so unmatched paths get the standard error envelope. */
export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`Cannot ${req.method} ${req.path}`));
}
