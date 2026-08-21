import type { AgentAvailability, UserRow, UserStatus } from './user.model.js';

/** Safe projection: never includes the password hash. */
export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  status: UserStatus;
  roleId: string;
  roleCode: string;
  roleName: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  /** Routing state, added in Phase 4. */
  availability: AgentAvailability;
  /** Null means the system default applies. */
  maxOpenTickets: number | null;
}

export interface UserWithRole extends UserRow {
  roleCode: string;
  roleName: string;
}

export interface ListUsersFilter {
  status?: UserStatus;
  roleId?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

export type { AgentAvailability, UserRow, UserStatus };
