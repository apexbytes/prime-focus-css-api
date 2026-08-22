import type { TicketChannel } from '../ticket/ticket.types.js';
import type { ChannelConversationRow, ConversationStatus } from './conversation.model.js';

/**
 * The channels a customer can be replied *to* on.
 *
 * Narrower than `TicketChannel` on purpose: `agent`, `api` and `web_form` say
 * where a ticket came from, not where somebody is waiting. A reply on one of
 * those goes out by email, which is why they are not here.
 */
export const REPLYABLE_CHANNELS = ['email', 'chat', 'whatsapp'] as const;

export type ReplyableChannel = (typeof REPLYABLE_CHANNELS)[number];

/** Channels whose threads are tracked as conversation rows. */
export const CONVERSATION_CHANNELS = ['chat', 'whatsapp'] as const;

export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

export function isConversationChannel(channel: TicketChannel): channel is ConversationChannel {
  return (CONVERSATION_CHANNELS as readonly string[]).includes(channel);
}

/**
 * One inbound message, as the channel's adapter has normalised it.
 *
 * Every channel arrives in its own shape — a Meta webhook envelope, a socket
 * frame — and is reduced to this before the pipeline sees it. That reduction is
 * the whole reason adding a channel is an adapter rather than a change to the
 * filing logic: `fileInbound` has never heard of WhatsApp.
 */
export interface NormalisedInboundMessage {
  channel: ConversationChannel;
  /** The provider's id, and the deduplication key across redeliveries. */
  providerMessageId: string;
  /** The thread key: a phone number, a chat conversation id. */
  conversationExternalId: string;
  /** Who sent it, in the channel's terms. */
  fromIdentifier: string;
  displayName?: string | undefined;
  body: string | null;
  /** Which product this lands in, when the channel can tell. */
  productId?: string | undefined;
  /** The envelope as received. */
  payload: unknown;
  occurredAt?: Date | undefined;
}

export interface InboundRecordResult {
  id: string;
  duplicate: boolean;
}

export interface InboundProcessResult {
  status: 'processed' | 'ignored' | 'failed';
  conversationId?: string;
  ticketId?: string;
  ticketMessageId?: string;
  /** True when this message opened a new ticket rather than joining one. */
  created?: boolean;
  reason?: string;
}

/** What happened to an agent's public reply on its way out. */
export interface DispatchResult {
  channel: TicketChannel;
  delivered: boolean;
  /** Which transport carried it — `email` for anything with no live thread. */
  transport: 'email' | 'whatsapp' | 'chat' | 'none';
  reason?: string;
}

export interface ConversationView {
  id: string;
  channel: TicketChannel;
  externalId: string;
  status: ConversationStatus;
  productId: string;
  customerId: string;
  customerName: string;
  ticketId: string | null;
  ticketReference: string | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  /** Null on a channel with no window, past on one whose window has closed. */
  windowExpiresAt: Date | null;
  createdAt: Date;
}

export interface ListConversationsFilter {
  channel?: ConversationChannel;
  status?: ConversationStatus;
  productId?: string;
  limit: number;
  cursor?: string;
}

export type { ChannelConversationRow, ConversationStatus };
