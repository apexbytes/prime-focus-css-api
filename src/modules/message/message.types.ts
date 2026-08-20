import type {
  MessageAuthorType,
  MessageVisibility,
  NewTicketMessage,
  TicketMessageRow,
} from './message.model.js';

/** One entry in a ticket thread, as other modules consume it. */
export type { MessageAuthorType, MessageVisibility, NewTicketMessage, TicketMessageRow };

export interface ThreadEntry {
  id: string;
  ticketId: string;
  authorType: MessageAuthorType;
  authorUserName: string | null;
  authorCustomerName: string | null;
  visibility: MessageVisibility;
  body: string;
  createdAt: Date;
}
