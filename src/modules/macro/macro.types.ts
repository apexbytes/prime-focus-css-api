import type { TicketPriority, TicketStatus } from '../ticket/ticket.types.js';
import type { MacroRow } from './macro.model.js';

/** What applying a macro changes, beyond posting its reply text. */
export interface MacroActions {
  status?: TicketStatus;
  priority?: TicketPriority;
  categoryId?: string;
  addTags?: string[];
  /** `self` assigns to whoever applied it — the common case for a macro. */
  assignTo?: 'self' | 'unassign';
}

export interface AppliedMacro {
  ticketId: string;
  macroId: string;
  /** Rendered reply text, ready for the agent to review before sending. */
  body: string | null;
  applied: MacroActions;
}

export type { MacroRow };
