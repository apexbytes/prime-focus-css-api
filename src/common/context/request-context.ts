import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActorKind } from '../types/actor.js';

/**
 * Ambient per-request state. Populated by the correlationId middleware and read
 * by the logger, so any log line, DB query, or queued job emitted while handling
 * a request carries the same id without threading it through every signature.
 */
export interface RequestContext {
  requestId: string;
  method?: string;
  path?: string;
  ip?: string;
  userAgent?: string;
  actorId?: string;
  actorType?: ActorKind;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Attach identity to the active context once authentication has resolved it.
 * No-op outside a request (e.g. cron jobs).
 */
export function setActor(actor: Pick<RequestContext, 'actorId' | 'actorType'>): void {
  const context = storage.getStore();
  if (!context) return;
  context.actorId = actor.actorId;
  context.actorType = actor.actorType;
}
