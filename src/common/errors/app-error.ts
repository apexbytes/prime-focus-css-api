import { ErrorCode } from './error-codes.js';

export interface ErrorDetail {
  field?: string;
  issue: string;
}

interface AppErrorOptions {
  details?: ErrorDetail[];
  cause?: unknown;
  /** Extra context for logs only — never serialised into the response. */
  context?: Record<string, unknown>;
}

/**
 * Every error the API intends to produce. `isOperational` distinguishes an
 * expected outcome (validation, not found) from a bug or dependency failure:
 * the error handler only logs stack traces and pages for the latter.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: ErrorDetail[];
  readonly context?: Record<string, unknown>;
  readonly isOperational = true;

  constructor(statusCode: number, code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    if (options.details) this.details = options.details;
    if (options.context) this.context = options.context;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message: string, options?: AppErrorOptions): AppError {
    return new AppError(400, ErrorCode.BAD_REQUEST, message, options);
  }

  static validation(message = 'Request validation failed', options?: AppErrorOptions): AppError {
    return new AppError(400, ErrorCode.VALIDATION_ERROR, message, options);
  }

  static unauthenticated(message = 'Authentication required', options?: AppErrorOptions): AppError {
    return new AppError(401, ErrorCode.UNAUTHENTICATED, message, options);
  }

  static forbidden(
    message = 'You do not have permission to perform this action',
    options?: AppErrorOptions,
  ): AppError {
    return new AppError(403, ErrorCode.FORBIDDEN, message, options);
  }

  static notFound(message = 'Resource not found', options?: AppErrorOptions): AppError {
    return new AppError(404, ErrorCode.NOT_FOUND, message, options);
  }

  static conflict(message: string, options?: AppErrorOptions): AppError {
    return new AppError(409, ErrorCode.CONFLICT, message, options);
  }

  static rateLimited(message = 'Too many requests', options?: AppErrorOptions): AppError {
    return new AppError(429, ErrorCode.RATE_LIMITED, message, options);
  }

  static unavailable(
    message = 'Service temporarily unavailable',
    options?: AppErrorOptions,
  ): AppError {
    return new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, message, options);
  }

  static internal(message = 'An unexpected error occurred', options?: AppErrorOptions): AppError {
    return new AppError(500, ErrorCode.INTERNAL_ERROR, message, options);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
