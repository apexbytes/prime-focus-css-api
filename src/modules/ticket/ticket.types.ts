import type { TicketChannel, TicketPriority, TicketRow, TicketStatus } from './ticket.model.js';

export interface TicketSummary {
  id: string;
  reference: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  channel: TicketChannel;
  productId: string;
  productName: string;
  customerId: string;
  customerName: string;
  /** Null for a customer who has only ever reached the desk on a channel. */
  customerEmail: string | null;
  categoryId: string | null;
  categoryName: string | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
  teamId: string | null;
  tags: string[];
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  lastCustomerReplyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListTicketsFilter {
  status?: TicketStatus[];
  priority?: TicketPriority[];
  productId?: string;
  categoryId?: string;
  assignedToUserId?: string;
  /** `true` restricts to tickets nobody owns — the queue to pick from. */
  unassigned?: boolean;
  customerId?: string;
  teamId?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

export type { TicketChannel, TicketPriority, TicketRow, TicketStatus };
