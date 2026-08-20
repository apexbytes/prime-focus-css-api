import type { ApiKeyRow } from './api-key.model.js';

export interface PublicApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreatedApiKey extends PublicApiKey {
  /** Shown exactly once, at creation. Never recoverable afterwards. */
  key: string;
}

export type { ApiKeyRow };
