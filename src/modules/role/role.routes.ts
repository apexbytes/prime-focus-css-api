import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  createRole,
  deleteRole,
  getRole,
  listPermissions,
  listRoles,
  setRolePermissions,
  updateRole,
} from './role.controller.js';
import { createRoleBody, roleIdParams, setPermissionsBody, updateRoleBody } from './role.schema.js';

export const roleRouter: Router = Router();

roleRouter.use(authenticate);

roleRouter.get('/', requirePermission('role:read'), listRoles);
roleRouter.post(
  '/',
  requirePermission('role:manage'),
  validate({ body: createRoleBody }),
  createRole,
);

roleRouter.get('/:id', requirePermission('role:read'), validate({ params: roleIdParams }), getRole);
roleRouter.patch(
  '/:id',
  requirePermission('role:manage'),
  validate({ params: roleIdParams, body: updateRoleBody }),
  updateRole,
);
roleRouter.put(
  '/:id/permissions',
  requirePermission('role:manage'),
  validate({ params: roleIdParams, body: setPermissionsBody }),
  setRolePermissions,
);
roleRouter.delete(
  '/:id',
  requirePermission('role:manage'),
  validate({ params: roleIdParams }),
  deleteRole,
);

/** Mounted separately at /permissions — it is a catalogue, not a role sub-resource. */
export const permissionRouter: Router = Router();
permissionRouter.get('/', authenticate, requirePermission('role:read'), listPermissions);
