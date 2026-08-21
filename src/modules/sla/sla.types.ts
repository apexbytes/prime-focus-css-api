import type { TicketPriority } from '../ticket/ticket.types.js';
import type {
  BusinessHoursRow,
  BusinessHoursWindow,
  HolidayRow,
  SlaPolicyRow,
  SlaTargetKind,
  TicketSlaTargetRow,
} from './sla.model.js';

/** A calendar with its holidays resolved, as returned to the console. */
export interface BusinessHoursWithHolidays extends BusinessHoursRow {
  holidays: HolidayRow[];
}

/** A live target with the derived numbers the console needs to draw a bar. */
export interface SlaTargetView {
  id: string;
  kind: SlaTargetKind;
  targetMinutes: number;
  dueAt: Date;
  /** 0–1 and beyond; above 1 means the deadline has passed. */
  consumed: number;
  /** Null while the clock is paused: there is no meaningful countdown. */
  minutesRemaining: number | null;
  paused: boolean;
  satisfiedAt: Date | null;
  breachedAt: Date | null;
}

/** One overdue or nearly-overdue target, as the scan sees it. */
export interface DueTarget {
  target: TicketSlaTargetRow;
  ticketId: string;
  productId: string;
  priority: TicketPriority;
  assignedToUserId: string | null;
  reference: string;
  subject: string;
}

export type {
  BusinessHoursRow,
  BusinessHoursWindow,
  HolidayRow,
  SlaPolicyRow,
  SlaTargetKind,
  TicketSlaTargetRow,
};
