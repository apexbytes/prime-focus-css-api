import { Router } from 'express';
import { authRateLimit, validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission, requireUserActor } from '../auth/auth.middleware.js';
import {
  completeLogin,
  createProvider,
  deleteProvider,
  getProvider,
  listIdentities,
  listProviders,
  listSignInProviders,
  startLogin,
  unlinkIdentity,
  updateProvider,
} from './sso.controller.js';
import {
  completeLoginBody,
  createProviderBody,
  idParams,
  startLoginBody,
  updateProviderBody,
} from './sso.schema.js';

/**
 * Mounted at /auth/sso — the federated half of the `auth` module's surface, in
 * its own module because it owns three tables and talks to an external
 * provider, but deliberately answering with the same `LoginResult` the password
 * flow does.
 *
 * `GET /providers` is public. The other two carry the credential limiter: a
 * `state` is short-lived and single-use, but `start` costs an outbound
 * discovery request and a row, and neither should be free to spray.
 */
export const ssoRouter: Router = Router();

ssoRouter.get('/providers', listSignInProviders);
ssoRouter.post('/start', authRateLimit, validate({ body: startLoginBody }), startLogin);
ssoRouter.post('/callback', authRateLimit, validate({ body: completeLoginBody }), completeLogin);

// -- a signed-in user's own links --------------------------------------------

ssoRouter.use('/identities', authenticate, requireUserActor);
ssoRouter.get('/identities', listIdentities);
ssoRouter.delete('/identities/:id', validate({ params: idParams }), unlinkIdentity);

/**
 * Mounted at /identity-providers.
 *
 * `sso:manage` rather than `user:manage`: configuring a provider decides which
 * addresses can become signed-in members of staff, which is closer to issuing an
 * API key than to editing somebody's phone number.
 */
export const identityProviderRouter: Router = Router();

identityProviderRouter.use(authenticate);

identityProviderRouter.get('/', requirePermission('sso:read'), listProviders);
identityProviderRouter.post(
  '/',
  requirePermission('sso:manage'),
  validate({ body: createProviderBody }),
  createProvider,
);
identityProviderRouter.get(
  '/:id',
  requirePermission('sso:read'),
  validate({ params: idParams }),
  getProvider,
);
identityProviderRouter.patch(
  '/:id',
  requirePermission('sso:manage'),
  validate({ params: idParams, body: updateProviderBody }),
  updateProvider,
);
identityProviderRouter.delete(
  '/:id',
  requirePermission('sso:manage'),
  validate({ params: idParams }),
  deleteProvider,
);
