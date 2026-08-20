import { Router } from 'express';
import { API_PREFIX, env, SERVICE_NAME } from '../config/index.js';
import { sendSuccess } from '../common/utils/response.js';

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
    modules: [] as string[],
  });
});

// Phase 2: v1Router.use('/auth', authRouter) ... etc.
