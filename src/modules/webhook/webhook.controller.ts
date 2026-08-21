import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as webhookService from './webhook.service.js';
import type {
  CreateSubscriptionBody,
  ListDeliveriesQuery,
  UpdateSubscriptionBody,
} from './webhook.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listSubscriptions(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await webhookService.list());
}

/** The catalogue, so a console can render the checkboxes without hardcoding it. */
export function listEventTypes(_req: Request, res: Response): void {
  sendSuccess(res, { eventTypes: webhookService.eventTypes() });
}

export async function getSubscription(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await webhookService.get(req.params.id as string));
}

/**
 * 201 with the signing secret in the body — the only response that ever carries
 * it. Losing it means creating a new subscription, which is also how it is
 * rotated.
 */
export async function createSubscription(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateSubscriptionBody;
  sendSuccess(res, await webhookService.create(body, actorOf(req)), { status: 201 });
}

export async function updateSubscription(req: Request, res: Response): Promise<void> {
  const body = req.body as UpdateSubscriptionBody;
  sendSuccess(res, await webhookService.update(req.params.id as string, body, actorOf(req)));
}

export async function deleteSubscription(req: Request, res: Response): Promise<void> {
  await webhookService.remove(req.params.id as string, actorOf(req));
  sendNoContent(res);
}

export async function listDeliveries(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListDeliveriesQuery;
  const items = await webhookService.listDeliveries(req.params.id as string, query);

  sendSuccess(res, items, {
    pagination: {
      limit: query.limit,
      hasMore: items.length === query.limit,
      nextCursor:
        items.length === query.limit ? (items.at(-1)?.createdAt.toISOString() ?? null) : null,
    },
  });
}

export async function redeliver(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await webhookService.redeliver(req.params.id as string, actorOf(req)));
}
