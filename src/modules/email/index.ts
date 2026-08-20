export { emailAdminRouter, emailWebhookRouter } from './email.routes.js';
export {
  __setInboundFetcher,
  outboundForTicket,
  processInbound,
  recordInbound,
  sendTicketReply,
} from './email.service.js';
export type { InboundWebhookEvent } from './email.types.js';
