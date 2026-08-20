import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../../config/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { AppError, ErrorCode, isAppError, type ErrorDetail } from '../errors/index.js';
import type { ApiFailure } from '../types/api.js';

const log = createModuleLogger('error-handler');

/** Postgres error codes worth translating into a meaningful HTTP status. */
const PG_ERROR_MAP: Record<
  string,
  { status: number; code: (typeof ErrorCode)[keyof typeof ErrorCode]; message: string }
> = {
  '23505': {
    status: 409,
    code: ErrorCode.UNIQUE_VIOLATION,
    message: 'A record with these values already exists',
  },
  '23503': {
    status: 409,
    code: ErrorCode.FOREIGN_KEY_VIOLATION,
    message: 'Referenced record does not exist',
  },
  '23502': {
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    message: 'A required field was missing',
  },
  '22P02': {
    status: 400,
    code: ErrorCode.BAD_REQUEST,
    message: 'A value was not in the expected format',
  },
  '22001': {
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    message: 'A value exceeded its maximum length',
  },
  '57014': {
    status: 503,
    code: ErrorCode.SERVICE_UNAVAILABLE,
    message: 'The database query timed out',
  },
  '53300': {
    status: 503,
    code: ErrorCode.SERVICE_UNAVAILABLE,
    message: 'The database is at capacity',
  },
};

interface BodyParserError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
}

function hasCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/** Collapse anything thrown anywhere in the stack into a single AppError. */
function normalise(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof ZodError) {
    const details: ErrorDetail[] = error.issues.map((issue) => ({
      field: issue.path.map(String).join('.') || undefined,
      issue: issue.message,
    }));
    return AppError.validation('Request validation failed', { details, cause: error });
  }

  // express.json() failures: malformed body, oversized payload, wrong type.
  const parserError = error as BodyParserError;
  if (parserError?.type === 'entity.parse.failed') {
    return AppError.badRequest('Malformed JSON in request body', { cause: error });
  }
  if (parserError?.type === 'entity.too.large') {
    return new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'Request body is too large', {
      cause: error,
    });
  }
  if (parserError?.type === 'entity.verify.failed') {
    return AppError.badRequest('Request body signature verification failed', { cause: error });
  }

  if (hasCode(error)) {
    const mapped = PG_ERROR_MAP[error.code];
    if (mapped) {
      return new AppError(mapped.status, mapped.code, mapped.message, { cause: error });
    }
    if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) {
      return new AppError(
        503,
        ErrorCode.DEPENDENCY_FAILURE,
        'A downstream dependency is unreachable',
        {
          cause: error,
        },
      );
    }
  }

  return AppError.internal(undefined, { cause: error });
}

/**
 * Terminal middleware. Nothing below this may throw: it must always produce the
 * error envelope, and it must never leak an internal message to the client.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const appError = normalise(error);
  const isServerError = appError.statusCode >= 500;

  log.log(isServerError ? 'error' : 'warn', appError.message, {
    code: appError.code,
    status: appError.statusCode,
    method: req.method,
    path: req.path,
    ...appError.context,
    // Only server-side faults justify a stack trace in the logs.
    ...(isServerError ? { err: appError.cause ?? appError } : {}),
  });

  // The response is already streaming — the connection must be destroyed rather
  // than have a JSON body appended to a partial payload.
  if (res.headersSent) {
    next(error);
    return;
  }

  const body: ApiFailure = {
    success: false,
    error: {
      code: appError.code,
      // A 500's real message may name internals; clients get a fixed string.
      message: isServerError && isProduction ? 'An unexpected error occurred' : appError.message,
      ...(appError.details ? { details: appError.details } : {}),
    },
    meta: { requestId: req.requestId },
  };

  res.status(appError.statusCode).json(body);
}
