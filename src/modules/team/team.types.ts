import type { TeamRow } from './team.model.js';

export interface TeamMemberSummary {
  userId: string;
  fullName: string;
  email: string;
  isLead: boolean;
}

export interface TeamWithMembers extends TeamRow {
  members: TeamMemberSummary[];
}

export type { TeamRow };
