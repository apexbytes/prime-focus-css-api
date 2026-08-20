import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { UserActor } from '../../common/types/actor.js';
import { sendSuccess } from '../../common/utils/response.js';
import * as notificationService from './notification.service.js';
import type { ListNotificationsQuery, UpdatePreferencesBody } from './notification.schema.js';

/** Notifications are strictly per-user; there is no cross-user read path. */
function userActor(req: Request): UserActor {
  if (req.actor?.kind !== 'user')
    throw AppError.forbidden('This endpoint requires a signed-in user');
  return req.actor;
}

export async function listNotifications(req: Request, res: Response): Promise<void> {
  const actor = userActor(req);
  const query = req.query as unknown as ListNotificationsQuery;

  const rows = await notificationService.list(actor.id, {
    unreadOnly: query.unreadOnly,
    limit: query.limit + 1,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;

  sendSuccess(res, items, {
    pagination: {
      limit: query.limit,
      hasMore,
      nextCursor: hasMore ? (items.at(-1)?.createdAt.toISOString() ?? null) : null,
    },
    meta: { unreadCount: await notificationService.unreadCount(actor.id) },
  });
}

export async function markRead(req: Request, res: Response): Promise<void> {
  const actor = userActor(req);
  sendSuccess(res, await notificationService.markRead(actor.id, req.params.id as string));
}

export async function markAllRead(req: Request, res: Response): Promise<void> {
  const actor = userActor(req);
  sendSuccess(res, { marked: await notificationService.markAllRead(actor.id) });
}

export async function getPreferences(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await notificationService.getPreferences(userActor(req).id));
}

export async function updatePreferences(req: Request, res: Response): Promise<void> {
  const actor = userActor(req);
  sendSuccess(
    res,
    await notificationService.updatePreferences(actor.id, req.body as UpdatePreferencesBody),
  );
}
