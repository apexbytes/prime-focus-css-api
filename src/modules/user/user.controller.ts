import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { isUserActor, type Actor } from '../../common/types/actor.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as userService from './user.service.js';
import type {
  ChangeAvailabilityBody,
  ChangeCapacityBody,
  ChangeRoleBody,
  ChangeStatusBody,
  ListUsersQuery,
  UpdateUserBody,
} from './user.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listUsers(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListUsersQuery;
  const rows = await userService.listUsers({ ...query, limit: query.limit + 1 });

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;

  sendSuccess(res, items.map(userService.toPublicUser), {
    pagination: {
      limit: query.limit,
      hasMore,
      nextCursor: hasMore ? (items.at(-1)?.email ?? null) : null,
    },
  });
}

export async function getUser(req: Request, res: Response): Promise<void> {
  const user = await userService.requireById(req.params.id as string);
  sendSuccess(res, userService.toPublicUser(user));
}

/**
 * Anyone may edit their own name and phone; editing someone else's requires
 * `user:manage`, which the route enforces before this runs.
 */
export async function updateUser(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const targetId = req.params.id as string;
  const body = req.body as UpdateUserBody;

  sendSuccess(res, await userService.updateProfile(targetId, body, actor));
}

export async function changeRole(req: Request, res: Response): Promise<void> {
  const { roleId } = req.body as ChangeRoleBody;
  sendSuccess(res, await userService.changeRole(req.params.id as string, roleId, actorOf(req)));
}

export async function changeStatus(req: Request, res: Response): Promise<void> {
  const { status } = req.body as ChangeStatusBody;
  sendSuccess(res, await userService.changeStatus(req.params.id as string, status, actorOf(req)));
}

export async function deleteUser(req: Request, res: Response): Promise<void> {
  await userService.deleteUser(req.params.id as string, actorOf(req));
  sendNoContent(res);
}

/** Self-service profile edit, so an agent does not need `user:manage`. */
export async function updateOwnProfile(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  if (!isUserActor(actor)) throw AppError.forbidden('This endpoint requires a signed-in user');

  sendSuccess(res, await userService.updateProfile(actor.id, req.body as UpdateUserBody, actor));
}

export async function changeAvailability(req: Request, res: Response): Promise<void> {
  const { availability } = req.body as ChangeAvailabilityBody;
  sendSuccess(
    res,
    await userService.setAvailability(req.params.id as string, availability, actorOf(req)),
  );
}

/** An agent marking themselves online or away, without needing `user:manage`. */
export async function changeOwnAvailability(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  if (!isUserActor(actor)) throw AppError.forbidden('This endpoint requires a signed-in user');

  const { availability } = req.body as ChangeAvailabilityBody;
  sendSuccess(res, await userService.setAvailability(actor.id, availability, actor));
}

export async function changeCapacity(req: Request, res: Response): Promise<void> {
  const { maxOpenTickets } = req.body as ChangeCapacityBody;
  sendSuccess(
    res,
    await userService.setCapacity(req.params.id as string, maxOpenTickets, actorOf(req)),
  );
}
