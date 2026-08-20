import { Router } from 'express';
import { liveness, readiness } from './health.controller.js';

/**
 * Mounted at the root rather than under `/api/v1`: orchestrators, load
 * balancers, and uptime checks expect stable unversioned probe paths.
 */
export const healthRouter: Router = Router();

healthRouter.get('/healthz', liveness);
healthRouter.get('/readyz', readiness);
