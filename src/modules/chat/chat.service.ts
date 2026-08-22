import { randomUUID } from 'node:crypto';
import { env } from '../../config/index.js';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { generateSecret, hashSecret } from '../../common/utils/crypto.js';
import { getJson, setJson } from '../../lib/cache/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { broadcast } from '../../lib/socket/index.js';
import * as conversationService from '../conversation/conversation.service.js';
import * as customerService from '../customer/customer.service.js';
import * as messageService from '../message/message.service.js';
import * as productService from '../product/product.service.js';
import * as repository from './chat.repository.js';
import type { ChatSessionRow } from './chat.model.js';
import {
  CHAT_EVENT,
  CHAT_ROOM,
  type ChatTranscriptEntry,
  type ChatVisitor,
  type StartedChatSession,
} from './chat.types.js';

const log = createModuleLogger('chat');

// -- sessions -----------------------------------------------------------------

export interface StartSessionInput {
  /** Optional: the widget may say which product it was embedded for. */
  productCode?: string | undefined;
  displayName?: string | undefined;
  /** Volunteered, never trusted as identity — see `verifiedIdentity` below. */
  contactEmail?: string | undefined;
  page?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Opens a live-chat session and hands the widget its credential.
 *
 * This is the only endpoint in the system that gives an unauthenticated caller a
 * bearer token, so it is worth being explicit about what the token is and is
 * not. It authorises writing to *one* conversation and reading *that*
 * conversation's public messages. It is not an identity: an address typed into
 * the widget is contact detail an agent may find useful, and it deliberately
 * does **not** link the session to an existing customer record — anyone can type
 * anybody's address, and matching on it would hand a stranger the thread history
 * of whoever owns that mailbox. The address is recorded on the session for the
 * agent to see and act on, and nothing else.
 */
export async function startSession(input: StartSessionInput): Promise<StartedChatSession> {
  if (!env.CHAT_ENABLED) {
    throw new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, 'Live chat is not available');
  }

  const product = await resolveProduct(input.productCode);

  const token = generateSecret(32);
  const externalId = randomUUID();
  const displayName = input.displayName?.trim() || 'Website visitor';

  // A customer record per session, with no email on it. See the argument above:
  // a self-declared address is not proof of anything, and `customers.email` is
  // the key that other people's threads hang off. An agent who establishes who
  // they are talking to can set the address, or merge the records.
  const customer = await customerService.createFromChannel({ fullName: displayName });

  const conversation = await conversationService.openConversation({
    channel: 'chat',
    externalId,
    productId: product.id,
    customerId: customer.id,
    displayName,
    ...(input.page || input.contactEmail
      ? {
          metadata: {
            ...(input.page ? { page: input.page } : {}),
            ...(input.contactEmail ? { declaredEmail: input.contactEmail } : {}),
          },
        }
      : {}),
  });

  const expiresAt = new Date(Date.now() + env.CHAT_SESSION_TTL_MINUTES * 60_000);

  await repository.insert({
    tokenHash: hashSecret(token),
    conversationExternalId: externalId,
    conversationId: conversation.id,
    productId: product.id,
    customerId: customer.id,
    displayName,
    contactEmail: input.contactEmail?.trim().toLowerCase() ?? null,
    expiresAt,
    lastSeenAt: new Date(),
    ...(input.page ? { metadata: { page: input.page } } : {}),
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  log.info('chat session started', { productId: product.id, conversationId: conversation.id });

  return {
    sessionToken: token,
    conversationExternalId: externalId,
    expiresAt,
    namespace: env.CHAT_NAMESPACE,
    path: env.REALTIME_PATH,
    productId: product.id,
    ticketReference: null,
  };
}

/**
 * Turns a session token into a visitor, or refuses.
 *
 * Called by the socket handshake and by every REST fallback call. The liveness
 * check is in the query rather than here, so an expired or ended session is
 * simply not found — there is no branch that could read a dead row and forget to
 * check a column.
 */
export async function authenticateVisitor(sessionToken: string | undefined): Promise<ChatVisitor> {
  if (!sessionToken) throw AppError.unauthenticated();

  const session = await repository.findLiveByTokenHash(hashSecret(sessionToken));
  // Deliberately the same answer for an unknown token, an expired one and one
  // whose session the desk ended: a visitor endpoint is a fine place to probe.
  if (!session) throw AppError.unauthenticated();

  return {
    kind: 'chat_visitor',
    sessionId: session.id,
    conversationExternalId: session.conversationExternalId,
    productId: session.productId,
    customerId: session.customerId,
    displayName: session.displayName,
  };
}

/**
 * Is this session still live?
 *
 * Read from the row rather than from the visitor object the handshake produced,
 * which is the whole point: the gateway calls this on a timer so ending a
 * conversation at the desk actually closes the socket, instead of taking effect
 * whenever the visitor next reloads.
 */
export async function revalidate(visitor: ChatVisitor): Promise<boolean> {
  const session = await repository.findById(visitor.sessionId);
  if (!session || session.endedAt) return false;
  return session.expiresAt.getTime() > Date.now();
}

export async function touch(visitor: ChatVisitor): Promise<void> {
  await repository.update(visitor.sessionId, { lastSeenAt: new Date() });
}

/** The visitor closed the widget, or the desk ended the conversation. */
export async function endSession(visitor: ChatVisitor): Promise<void> {
  await repository.update(visitor.sessionId, { endedAt: new Date() });

  broadcast(
    CHAT_ROOM.conversation(visitor.conversationExternalId),
    CHAT_EVENT.ended,
    { reason: 'ended' },
    env.CHAT_NAMESPACE,
  );
}

// -- messages -----------------------------------------------------------------

/**
 * A visitor's message, filed onto their conversation's ticket.
 *
 * Processed inline rather than queued, and that is the one place this channel
 * deliberately differs from WhatsApp. A WhatsApp sender has already had their
 * message accepted by Meta and does not care when the desk files it; a chat
 * visitor is watching a spinner. So the pipeline runs in the request, and the
 * durable inbound row is still written first — a crash mid-file leaves the same
 * recoverable row the queued path would have left, and the reprocess endpoint
 * drains it.
 */
export async function postVisitorMessage(
  visitor: ChatVisitor,
  body: string,
): Promise<{ ticketId?: string | undefined; created?: boolean | undefined }> {
  const trimmed = body.trim();
  if (!trimmed) throw AppError.validation('A message body is required');

  await enforceRate(visitor);

  const { id, duplicate } = await conversationService.recordInbound({
    channel: 'chat',
    // The widget has no provider ids to offer, so one is minted here. It is
    // still the deduplication key the table's unique index needs, and prefixing
    // it keeps chat and WhatsApp ids from ever colliding in that index.
    providerMessageId: `chat:${randomUUID()}`,
    conversationExternalId: visitor.conversationExternalId,
    fromIdentifier: visitor.conversationExternalId,
    displayName: visitor.displayName,
    body: trimmed,
    payload: { source: 'chat_widget', sessionId: visitor.sessionId },
  });

  if (duplicate) return {};

  const result = await conversationService.processInbound(id);
  await touch(visitor);

  if (result.status !== 'processed') {
    // The message is safely recorded; what failed is filing it. Telling the
    // visitor it worked would be a lie, and a 500 would invite them to send it
    // again and again.
    throw new AppError(
      503,
      ErrorCode.SERVICE_UNAVAILABLE,
      'Your message was received but could not be filed yet; an agent will still see it',
    );
  }

  return { ticketId: result.ticketId, created: result.created };
}

/**
 * The public half of the thread, for a widget that has just reloaded.
 *
 * Internal notes are excluded by the message module, not by a filter here: the
 * visibility rule is the highest-stakes flag in the system and it has exactly
 * one enforcement point.
 */
export async function transcript(visitor: ChatVisitor): Promise<ChatTranscriptEntry[]> {
  const conversation = await conversationService.findByExternalId(
    'chat',
    visitor.conversationExternalId,
  );

  if (!conversation?.ticketId) return [];

  const rows = await messageService.customerVisibleThread(conversation.ticketId, 100);

  return rows.map((row) => ({
    author:
      row.authorType === 'agent' ? 'agent' : row.authorType === 'system' ? 'system' : 'customer',
    body: row.body,
    createdAt: row.createdAt,
  }));
}

/** A visitor's typing indicator, for the agent's console. */
export function visitorTyping(visitor: ChatVisitor, isTyping: boolean): void {
  broadcast(
    CHAT_ROOM.conversation(visitor.conversationExternalId),
    CHAT_EVENT.typing,
    { author: 'customer', isTyping },
    env.CHAT_NAMESPACE,
  );
}

// -- rate limiting ------------------------------------------------------------

/**
 * How many messages one session may send per minute.
 *
 * The Express limiters cannot help here: a socket frame never passes through
 * middleware, so without this a single visitor could write a thousand messages
 * into a ticket. Counted through the shared cache, so the budget is per session
 * across instances when Redis is configured and per instance when it is not —
 * the same honest degradation the rest of the cache layer documents.
 *
 * A read-then-write counter has a race in it, and that is accepted: the failure
 * mode is a visitor occasionally getting one or two extra messages through,
 * which is not what this is defending against.
 */
async function enforceRate(visitor: ChatVisitor): Promise<void> {
  const key = `chat:rate:${visitor.sessionId}:${Math.floor(Date.now() / 60_000)}`;
  const used = (await getJson<number>(key)) ?? 0;

  if (used >= env.CHAT_MESSAGE_RATE_PER_MINUTE) {
    throw AppError.rateLimited();
  }

  await setJson(key, used + 1, 120);
}

// -- wiring -------------------------------------------------------------------

async function resolveProduct(code: string | undefined): Promise<{ id: string; name: string }> {
  const wanted = code ?? env.CHAT_PRODUCT_CODE ?? env.DEFAULT_PRODUCT_CODE;

  if (wanted) {
    const product = await productService.findByCode(wanted);
    // A code that names nothing is not an error the public should be able to
    // distinguish from one that does: it would make this endpoint a way to
    // enumerate the product catalogue.
    if (product) return product;
  }

  if (code) {
    log.warn('chat session requested an unknown product', { code });
  }

  throw new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, 'Live chat is not available');
}

/** Ends every session on a conversation the desk has closed. */
export function endSessionsForConversation(conversationId: string): Promise<number> {
  return repository.endForConversation(conversationId);
}

/** Called by the retention sweep: a dead token is debris, the thread is not. */
export function sweepExpiredSessions(before: Date, limit: number): Promise<number> {
  return repository.deleteExpiredBefore(before, limit);
}

export type { ChatSessionRow };
