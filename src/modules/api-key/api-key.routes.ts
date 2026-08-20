import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission, requireUserActor } from '../auth/auth.middleware.js';
import { createApiKey, listApiKeys, revokeApiKey } from './api-key.controller.js';
import { apiKeyIdParams, createApiKeyBody } from './api-key.schema.js';

export const apiKeyRouter: Router = Router();

// Only a signed-in human may mint credentials — an API key cannot issue itself
// a wider one.
apiKeyRouter.use(authenticate, requireUserActor);

apiKeyRouter.get('/', requirePermission('api_key:read'), listApiKeys);
apiKeyRouter.post(
  '/',
  requirePermission('api_key:manage'),
  validate({ body: createApiKeyBody }),
  createApiKey,
);
apiKeyRouter.delete(
  '/:id',
  requirePermission('api_key:manage'),
  validate({ params: apiKeyIdParams }),
  revokeApiKey,
);
