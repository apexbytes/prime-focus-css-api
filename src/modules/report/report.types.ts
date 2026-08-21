import type { ReportRange } from './report.range.js';
import type { ReportRefreshRow } from './report.model.js';

/**
 * Stamped on every report response.
 *
 * `refreshedAt` is the point: a figure served from a materialised view is as old
 * as the last refresh, and a dashboard that cannot say so invites someone to act
 * on a number from last Tuesday.
 */
export interface ReportMeta {
  from: string;
  to: string;
  days: number;
  /** Oldest refresh across the views this report reads; null if never refreshed. */
  refreshedAt: Date | null;
  /** True when a view this report depends on failed its last refresh. */
  stale: boolean;
}

export interface SlaCompliance {
  targets: number;
  met: number;
  breached: number;
  running: number;
  /** met ÷ (met + breached), as a whole percentage. Null when nothing settled. */
  compliancePercent: number | null;
}

export interface SlaReport {
  meta: ReportMeta;
  firstResponse: SlaCompliance;
  resolution: SlaCompliance;
  byPriority: (SlaCompliance & { priority: string; kind: string })[];
  byDay: (SlaCompliance & { day: string })[];
}

export interface VolumeBucket {
  key: string;
  label: string;
  created: number;
  resolved: number;
}

export interface VolumeReport {
  meta: ReportMeta;
  created: number;
  resolved: number;
  reopened: number;
  byDay: { day: string; created: number; resolved: number }[];
  byChannel: VolumeBucket[];
  byPriority: VolumeBucket[];
  byCategory: VolumeBucket[];
}

export interface AgentRow {
  userId: string;
  fullName: string | null;
  email: string | null;
  publicReplies: number;
  internalNotes: number;
  resolvedCount: number;
  reopenedCount: number;
  /** Wall clock, not working time — see the note on the views. */
  resolutionWallMinutesAvg: number | null;
  surveysSent: number;
  surveyResponses: number;
  averageScore: number | null;
}

export interface AgentReport {
  meta: ReportMeta;
  agents: AgentRow[];
}

export interface CsatReport {
  meta: ReportMeta;
  surveysSent: number;
  responses: number;
  responseRatePercent: number | null;
  averageScore: number | null;
  satisfactionPercent: number | null;
  dissatisfiedPercent: number | null;
  byDay: { day: string; surveysSent: number; responses: number; averageScore: number | null }[];
}

export interface OverviewReport {
  meta: ReportMeta;
  tickets: {
    created: number;
    resolved: number;
    reopened: number;
    /** Live count, not from a view — see the note in the service. */
    openNow: number;
    unassignedNow: number;
  };
  sla: { firstResponsePercent: number | null; resolutionPercent: number | null; breached: number };
  csat: { responses: number; averageScore: number | null; satisfactionPercent: number | null };
  knowledgeBase: {
    published: number;
    draft: number;
    suggested: number;
    opened: number;
    /** Suggestions shown per ticket raised: the crude deflection signal. */
    suggestionsPerTicket: number | null;
  };
  refreshes: ReportRefreshRow[];
}

export type { ReportRange, ReportRefreshRow };
