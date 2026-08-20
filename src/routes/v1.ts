import { Router } from 'express';
import { API_PREFIX, env, SERVICE_NAME } from '../config/index.js';
import { sendSuccess } from '../common/utils/response.js';
import { apiKeyRouter } from '../modules/api-key/index.js';
import { auditRouter } from '../modules/audit/index.js';
import { authRouter } from '../modules/auth/index.js';
import { invitationRouter } from '../modules/invitation/index.js';
import { trustedDeviceRouter } from '../modules/mfa/index.js';
import { permissionRouter, roleRouter } from '../modules/role/index.js';
import { teamRouter } from '../modules/team/index.js';
import { userRouter } from '../modules/user/index.js';

const MODULES = [
  'auth',
  'invitations',
  'users',
  'roles',
  'permissions',
  'teams',
  'api-keys',
  'audit-logs',
] as const;

/**
 * Every module router mounts here. Adding a module means one import and one
 * `use()` — nothing else in the app wiring changes.
 */
export const v1Router: Router = Router();

v1Router.get('/', (_req, res) => {
  sendSuccess(res, {
    service: SERVICE_NAME,
    version: env.APP_VERSION,
    apiVersion: 'v1',
    basePath: API_PREFIX,
    modules: [...MODULES],
  });
});

// Mounted before '/auth' so the more specific path is matched first.
v1Router.use('/auth/devices', trustedDeviceRouter);
v1Router.use('/auth', authRouter);

v1Router.use('/invitations', invitationRouter);
v1Router.use('/users', userRouter);
v1Router.use('/roles', roleRouter);
v1Router.use('/permissions', permissionRouter);
v1Router.use('/teams', teamRouter);
v1Router.use('/api-keys', apiKeyRouter);
v1Router.use('/audit-logs', auditRouter);

// Phase 3: products, customers, tickets, messages, attachments, macros.
