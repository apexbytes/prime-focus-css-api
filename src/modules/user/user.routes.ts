import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import {
  authenticate,
  requirePermission,
  requireSelfOrPermission,
  requireUserActor,
} from '../auth/auth.middleware.js';
import {
  changeRole,
  changeStatus,
  getUser,
  listUsers,
  updateOwnProfile,
  updateUser,
} from './user.controller.js';
import {
  changeRoleBody,
  changeStatusBody,
  listUsersQuery,
  updateUserBody,
  userIdParams,
} from './user.schema.js';

export const userRouter: Router = Router();

userRouter.use(authenticate);

userRouter.get('/', requirePermission('user:read'), validate({ query: listUsersQuery }), listUsers);

// Declared before '/:id' so the literal path is not swallowed by the parameter.
userRouter.patch('/me', requireUserActor, validate({ body: updateUserBody }), updateOwnProfile);

userRouter.get('/:id', requirePermission('user:read'), validate({ params: userIdParams }), getUser);

userRouter.patch(
  '/:id',
  validate({ params: userIdParams, body: updateUserBody }),
  requireSelfOrPermission('id', 'user:manage'),
  updateUser,
);

userRouter.patch(
  '/:id/role',
  requirePermission('user:manage'),
  validate({ params: userIdParams, body: changeRoleBody }),
  changeRole,
);

userRouter.patch(
  '/:id/status',
  requirePermission('user:manage'),
  validate({ params: userIdParams, body: changeStatusBody }),
  changeStatus,
);
