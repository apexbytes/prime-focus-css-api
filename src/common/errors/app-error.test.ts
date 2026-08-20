import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode, isAppError } from './index.js';

describe('AppError', () => {
  it('carries a status, a stable code and operational intent', () => {
    const error = AppError.notFound('Ticket not found');

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(error.isOperational).toBe(true);
    expect(isAppError(error)).toBe(true);
  });

  it('keeps field-level details for validation failures', () => {
    const error = AppError.validation('Request validation failed', {
      details: [{ field: 'body.priority', issue: 'Invalid enum value' }],
    });

    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual([{ field: 'body.priority', issue: 'Invalid enum value' }]);
  });

  it('preserves the original cause for logging', () => {
    const cause = new Error('connection reset');
    const error = AppError.internal('Something failed', { cause });

    expect(error.cause).toBe(cause);
  });

  it('separates log-only context from the response payload', () => {
    const error = AppError.conflict('Ticket already resolved', {
      context: { ticketId: 'PF-2026-000123' },
    });

    expect(error.context).toEqual({ ticketId: 'PF-2026-000123' });
    expect(error.details).toBeUndefined();
  });

  it('does not classify arbitrary errors as AppError', () => {
    expect(isAppError(new Error('nope'))).toBe(false);
  });
});
