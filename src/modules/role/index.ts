export { permissionRouter, roleRouter } from './role.routes.js';
export {
  invalidatePermissionCache,
  onPermissionInvalidation,
  permissionsForRole,
  requireRoleById,
} from './role.service.js';
export type { RoleWithPermissions } from './role.types.js';
