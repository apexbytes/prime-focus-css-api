import type { PermissionCode } from '../../common/types/permissions.js';
import type { PermissionRow, RoleRow } from './role.model.js';

export interface RoleWithPermissions extends RoleRow {
  permissions: PermissionCode[];
}

export interface CreateRoleInput {
  code: string;
  name: string;
  description?: string | undefined;
  permissions: PermissionCode[];
}

export interface UpdateRoleInput {
  name?: string | undefined;
  description?: string | undefined;
}

export type { PermissionRow, RoleRow };
