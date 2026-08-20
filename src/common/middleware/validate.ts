import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodError, ZodType } from 'zod';
import { AppError } from '../errors/index.js';

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

function toDetails(error: ZodError, source: string) {
  return error.issues.map((issue) => ({
    field: [source, ...issue.path.map(String)].filter(Boolean).join('.'),
    issue: issue.message,
  }));
}

/**
 * Validates and *replaces* the request parts with the parsed output, so handlers
 * receive coerced, trimmed, defaulted values rather than raw strings.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const details: { field: string; issue: string }[] = [];

    for (const source of ['params', 'query', 'body'] as const) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);
      if (result.success) {
        Object.defineProperty(req, source, {
          value: result.data,
          writable: true,
          configurable: true,
        });
      } else {
        details.push(...toDetails(result.error, source));
      }
    }

    if (details.length > 0) {
      next(AppError.validation('Request validation failed', { details }));
      return;
    }

    next();
  };
}
