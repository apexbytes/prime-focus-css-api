import type { ActorType } from './audit.model.js';

export interface AuditEntry {
  /** `entity.verb`, e.g. `user.invited`. */
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Omit to use the actor on the current request. */
  actorType?: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
}

export interface AuditLogFilter {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: string;
}

export type { ActorType };
