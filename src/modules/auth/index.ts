export { authRouter } from './auth.routes.js';
export {
  authenticate,
  requireAnyPermission,
  requirePermission,
  requireUserActor,
} from './auth.middleware.js';
export { assertPasswordAcceptable, revokeAccess } from './auth.service.js';
export type { LoginResult, TokenPair } from './auth.types.js';
