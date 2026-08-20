export { messageRouter } from './message.routes.js';
export {
  existsWithExternalMessageId,
  findTicketIdByExternalMessageId,
  recordCustomerMessage,
  recordSystemMessage,
} from './message.service.js';
export type { MessageVisibility, TicketMessageRow } from './message.types.js';
