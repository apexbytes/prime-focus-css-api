import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  applyMacro,
  createMacro,
  deleteMacro,
  listMacros,
  updateMacro,
} from './macro.controller.js';
import {
  applyMacroParams,
  createMacroBody,
  listMacrosQuery,
  macroIdParams,
  updateMacroBody,
} from './macro.schema.js';

export const macroRouter: Router = Router();

macroRouter.use(authenticate);

macroRouter.get(
  '/',
  requirePermission('ticket:read'),
  validate({ query: listMacrosQuery }),
  listMacros,
);
macroRouter.post(
  '/',
  requirePermission('ticket:manage'),
  validate({ body: createMacroBody }),
  createMacro,
);
macroRouter.patch(
  '/:id',
  requirePermission('ticket:manage'),
  validate({ params: macroIdParams, body: updateMacroBody }),
  updateMacro,
);
macroRouter.delete(
  '/:id',
  requirePermission('ticket:manage'),
  validate({ params: macroIdParams }),
  deleteMacro,
);

/**
 * Applies the field changes and returns the rendered reply for review — it does
 * not send anything, so a mis-click is recoverable.
 */
macroRouter.post(
  '/:id/apply/:ticketId',
  requirePermission('ticket:reply'),
  validate({ params: applyMacroParams }),
  applyMacro,
);
