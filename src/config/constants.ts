/** Values that are structural to the API rather than per-environment. */
export const SERVICE_NAME = 'prime-focus-css';

export const API_PREFIX = '/api/v1';

export const REQUEST_ID_HEADER = 'x-request-id';
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Cap on an inbound correlation id we are willing to echo back into logs. */
export const MAX_REQUEST_ID_LENGTH = 128;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Replayable idempotent responses are retained this long. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Paths that must never be rate limited or logged at info level. */
export const OPERATIONAL_PATHS = ['/healthz', '/readyz'] as const;
