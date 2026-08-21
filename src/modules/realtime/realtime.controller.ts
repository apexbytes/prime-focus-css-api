import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendSuccess } from '../../common/utils/response.js';
import * as realtimeService from './realtime.service.js';
import type { QueueCountsQuery } from './realtime.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

/**
 * The REST half of the lock protocol.
 *
 * Everything the websocket gateway offers is also here, so a console behind a
 * proxy that strips upgrades is slower rather than broken. The one difference
 * is that a lock taken this way carries no socket id, so it is released by its
 * expiry rather than by a disconnect.
 */
export async function getLock(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await realtimeService.lockState(req.params.ticketId as string, actorOf(req)));
}

export async function acquireLock(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await realtimeService.lock(req.params.ticketId as string, actorOf(req)));
}

export async function releaseLock(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await realtimeService.unlock(req.params.ticketId as string, actorOf(req)));
}

export async function queueCounts(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as QueueCountsQuery;
  sendSuccess(res, await realtimeService.queueCounts(query.productId, actorOf(req)));
}
