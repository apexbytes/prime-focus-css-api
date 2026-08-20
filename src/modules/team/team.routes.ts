import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  addTeamMember,
  createTeam,
  getTeam,
  listTeams,
  removeTeamMember,
  updateTeam,
} from './team.controller.js';
import {
  addMemberBody,
  createTeamBody,
  teamIdParams,
  teamMemberParams,
  updateTeamBody,
} from './team.schema.js';

export const teamRouter: Router = Router();

teamRouter.use(authenticate);

teamRouter.get('/', requirePermission('team:read'), listTeams);
teamRouter.post(
  '/',
  requirePermission('team:manage'),
  validate({ body: createTeamBody }),
  createTeam,
);

teamRouter.get('/:id', requirePermission('team:read'), validate({ params: teamIdParams }), getTeam);
teamRouter.patch(
  '/:id',
  requirePermission('team:manage'),
  validate({ params: teamIdParams, body: updateTeamBody }),
  updateTeam,
);

teamRouter.post(
  '/:id/members',
  requirePermission('team:manage'),
  validate({ params: teamIdParams, body: addMemberBody }),
  addTeamMember,
);
teamRouter.delete(
  '/:id/members/:userId',
  requirePermission('team:manage'),
  validate({ params: teamMemberParams }),
  removeTeamMember,
);
