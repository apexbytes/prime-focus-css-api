/**
 * Stable machine-readable error codes. Clients branch on these, never on the
 * message text, so a code is part of the API contract: add freely, never
 * repurpose or rename.
 */
export const ErrorCode = {
  // generic
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DEPENDENCY_FAILURE: 'DEPENDENCY_FAILURE',

  // auth (consumed from Phase 2 onward)
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  MFA_REQUIRED: 'MFA_REQUIRED',

  // data integrity
  UNIQUE_VIOLATION: 'UNIQUE_VIOLATION',
  FOREIGN_KEY_VIOLATION: 'FOREIGN_KEY_VIOLATION',

  // idempotency
  IDEMPOTENCY_KEY_IN_PROGRESS: 'IDEMPOTENCY_KEY_IN_PROGRESS',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
