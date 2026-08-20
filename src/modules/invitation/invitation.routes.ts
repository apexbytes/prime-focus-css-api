import { Router } from 'express';
import { authRateLimit, validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission, requireUserActor } from '../auth/auth.middleware.js';
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  previewInvitation,
  resendInvitation,
  revokeInvitation,
} from './invitation.controller.js';
import {
  acceptInvitationBody,
  createInvitationBody,
  invitationIdParams,
  invitationTokenBody,
} from './invitation.schema.js';

export const invitationRouter: Router = Router();

/**
 * Preview and accept are the only unauthenticated write paths in the system —
 * they are how a staff account comes into existence — so both are rate limited
 * as credential endpoints.
 */
invitationRouter.post(
  '/verify',
  authRateLimit,
  validate({ body: invitationTokenBody }),
  previewInvitation,
);
invitationRouter.post(
  '/accept',
  authRateLimit,
  validate({ body: acceptInvitationBody }),
  acceptInvitation,
);

// -- administration -----------------------------------------------------------

invitationRouter.use(authenticate, requireUserActor);

invitationRouter.get('/', requirePermission('user:read'), listInvitations);
invitationRouter.post(
  '/',
  requirePermission('user:invite'),
  validate({ body: createInvitationBody }),
  createInvitation,
);
invitationRouter.post(
  '/:id/resend',
  requirePermission('user:invite'),
  validate({ params: invitationIdParams }),
  resendInvitation,
);
invitationRouter.delete(
  '/:id',
  requirePermission('user:invite'),
  validate({ params: invitationIdParams }),
  revokeInvitation,
);
