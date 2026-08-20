import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import type { PermissionCode } from '../../common/types/permissions.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as roleService from './role.service.js';
import type { CreateRoleBody, SetPermissionsBody, UpdateRoleBody } from './role.schema.js';

/** The authenticate middleware guarantees this; the cast keeps handlers terse. */
function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listRoles(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await roleService.listRoles());
}

export async function listPermissions(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await roleService.listPermissions());
}

export async function getRole(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await roleService.getRole(req.params.id as string));
}

export async function createRole(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateRoleBody;
  const role = await roleService.createRole(
    { ...body, permissions: body.permissions as PermissionCode[] },
    actorOf(req),
  );
  sendSuccess(res, role, { status: 201 });
}

export async function updateRole(req: Request, res: Response): Promise<void> {
  const role = await roleService.updateRole(
    req.params.id as string,
    req.body as UpdateRoleBody,
    actorOf(req),
  );
  sendSuccess(res, role);
}

export async function setRolePermissions(req: Request, res: Response): Promise<void> {
  const body = req.body as SetPermissionsBody;
  const role = await roleService.setRolePermissions(
    req.params.id as string,
    body.permissions as PermissionCode[],
    actorOf(req),
  );
  sendSuccess(res, role);
}

export async function deleteRole(req: Request, res: Response): Promise<void> {
  await roleService.deleteRole(req.params.id as string, actorOf(req));
  sendNoContent(res);
}
