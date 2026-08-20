export { ticketRouter } from './ticket.routes.js';
export {
  findByReference,
  findRawById,
  registerAgentReply,
  registerCustomerReply,
  requireAccessible,
} from './ticket.service.js';
export { CLOCK_PAUSED_STATUSES, OPEN_STATUSES, canTransition } from './ticket.status.js';
export type { TicketRow, TicketStatus, TicketSummary } from './ticket.types.js';
