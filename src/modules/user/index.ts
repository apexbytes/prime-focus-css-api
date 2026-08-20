export { userRouter } from './user.routes.js';
export {
  activate,
  createInvited,
  findByEmail,
  findById,
  normaliseEmail,
  requireById,
  toPublicUser,
} from './user.service.js';
export type { PublicUser, UserWithRole } from './user.types.js';
