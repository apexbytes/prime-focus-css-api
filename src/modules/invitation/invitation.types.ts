import type { InvitationRow } from './invitation.model.js';

export interface PublicInvitation {
  id: string;
  email: string;
  fullName: string;
  roleId: string;
  roleName: string;
  invitedBy: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  sendCount: number;
  createdAt: Date;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}

/** What the accept screen needs before a password is chosen. */
export interface InvitationPreview {
  email: string;
  fullName: string;
  roleName: string;
  expiresAt: Date;
}

export type { InvitationRow };
