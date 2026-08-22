import { env } from '../../config/index.js';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { withTransaction, type Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { enqueue, JOB } from '../../lib/queue/index.js';
import { broadcast } from '../../lib/socket/index.js';
import {
  fetchWhatsappMedia,
  MediaTooLargeError,
  sendWhatsappTemplate,
  sendWhatsappText,
} from '../../lib/whatsapp/index.js';
import * as attachmentService from '../attachment/attachment.service.js';
import { CHAT_EVENT, CHAT_ROOM } from '../chat/chat.types.js';
import * as customerService from '../customer/customer.service.js';
import * as emailService from '../email/email.service.js';
import * as eventService from '../event/event.service.js';
import { DOMAIN_EVENT } from '../event/event.types.js';
// Cyclic with message.service and ticket.service, for the reason documented in
// ticket.service: filing an inbound message needs both, and replying needs to be
// callable from the message module. All three export hoisted function
// declarations and touch each other only inside function bodies.
import * as messageService from '../message/message.service.js';
import type { TicketMessageRow } from '../message/message.types.js';
import * as notificationService from '../notification/notification.service.js';
import * as productService from '../product/product.service.js';
import * as ticketService from '../ticket/ticket.service.js';
import type { TicketRow } from '../ticket/ticket.types.js';
import * as repository from './conversation.repository.js';
import type { ChannelConversationRow } from './conversation.model.js';
import {
  isConversationChannel,
  type ConversationChannel,
  type ConversationView,
  type DispatchResult,
  type InboundProcessResult,
  type InboundRecordResult,
  type ListConversationsFilter,
  type NormalisedInboundMedia,
  type NormalisedInboundMessage,
} from './conversation.types.js';

const log = createModuleLogger('conversation');

// -- inbound ------------------------------------------------------------------

/**
 * Records an inbound channel message and returns its row id.
 *
 * Persist-then-process, the same bargain the inbound email path makes: the
 * ingress stores what it was told and answers immediately, because a provider
 * that gets a 5xx retries and a slow handler times out. The row is the durable
 * record — if filing fails the customer's message is still here.
 */
export async function recordInbound(
  message: NormalisedInboundMessage,
): Promise<InboundRecordResult> {
  const existing = await repository.findInboundByProviderId(message.providerMessageId);
  if (existing) {
    log.info('duplicate inbound channel message ignored', {
      channel: message.channel,
      providerMessageId: message.providerMessageId,
    });
    return { id: existing.id, duplicate: true };
  }

  const row = await repository.insertInbound({
    channel: message.channel,
    providerMessageId: message.providerMessageId,
    conversationExternalId: message.conversationExternalId,
    fromIdentifier: message.fromIdentifier,
    displayName: message.displayName ?? null,
    body: message.body,
    media: message.media ?? null,
    payload: message.payload,
    ...(message.occurredAt ? { receivedAt: message.occurredAt } : {}),
  });

  // Lost the race with a concurrent redelivery; the other one owns it.
  if (!row) {
    const settled = await repository.findInboundByProviderId(message.providerMessageId);
    return { id: settled?.id ?? '', duplicate: true };
  }

  return { id: row.id, duplicate: false };
}

/**
 * Hands a recorded message to the queue for filing.
 *
 * A queued job from the first day of this channel, unlike the email path which
 * still files inline. There is nothing to preserve here: no verified inline
 * behaviour to re-prove, and a WhatsApp message lost to a restart is a customer
 * who was ignored, so it gets the retry-across-restart that Phase 3 deferred.
 */
export async function queueInbound(inboundId: string): Promise<void> {
  await enqueue(JOB.channelInboundProcess, { inboundId });
}

/**
 * Turns a recorded inbound message into a ticket message.
 *
 * Idempotent: re-running for an already-processed row is a no-op, which is what
 * makes both the queue's retry and the operator's reprocess endpoint safe.
 */
export async function processInbound(inboundId: string): Promise<InboundProcessResult> {
  const inbound = await repository.findInboundById(inboundId);
  if (!inbound) throw AppError.notFound('Inbound channel message not found');

  if (inbound.status === 'processed') {
    return {
      status: 'processed',
      ...(inbound.conversationId ? { conversationId: inbound.conversationId } : {}),
      ...(inbound.ticketId ? { ticketId: inbound.ticketId } : {}),
    };
  }

  const channel = inbound.channel;
  if (!isConversationChannel(channel)) {
    await settle(inbound.id, 'ignored', `channel ${channel} has no conversation pipeline`);
    return { status: 'ignored', reason: `channel ${channel} has no conversation pipeline` };
  }

  const media = (inbound.media ?? null) as NormalisedInboundMedia | null;
  const caption = inbound.body?.trim();

  // A message is actionable if it has words *or* a file. Only a message with
  // neither — a location pin, a reaction, a contact card — is dropped, and even
  // then it is recorded with a reason rather than vanishing.
  if (!caption && !media) {
    await settle(inbound.id, 'ignored', 'no readable body');
    return { status: 'ignored', reason: 'no readable body' };
  }

  try {
    return await file(inbound.id, {
      channel,
      externalId: inbound.conversationExternalId,
      fromIdentifier: inbound.fromIdentifier,
      displayName: inbound.displayName,
      // A file with no caption still needs a body: a thread entry with no text
      // reads as a bug, and the subject of a new ticket comes from it.
      body: caption || describeMedia(media as NormalisedInboundMedia),
      ...(media ? { media } : {}),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    await repository.updateInbound(inbound.id, { status: 'failed', error: reason });
    log.error('failed to process inbound channel message', { inboundId: inbound.id, err: error });
    return { status: 'failed', reason };
  }
}

interface FilingInput {
  channel: ConversationChannel;
  externalId: string;
  fromIdentifier: string;
  displayName: string | null;
  body: string;
  media?: NormalisedInboundMedia | undefined;
}

async function file(inboundId: string, input: FilingInput): Promise<InboundProcessResult> {
  const product = await resolveProduct(input.channel);
  const conversation = await resolveConversation(input, product.id);

  // An open conversation already pointing at a ticket is a reply; anything else
  // is a new query. A conversation the idle sweep closed has had its ticket
  // detached deliberately, so a customer writing back next month opens fresh
  // work rather than reopening something the desk finished weeks ago.
  const existingTicketId =
    conversation.status === 'open' && conversation.ticketId ? conversation.ticketId : null;

  if (existingTicketId) {
    return appendToTicket(inboundId, conversation, existingTicketId, input);
  }

  return openTicket(inboundId, conversation, product, input);
}

async function appendToTicket(
  inboundId: string,
  conversation: ChannelConversationRow,
  ticketId: string,
  input: FilingInput,
): Promise<InboundProcessResult> {
  const filed = await withTransaction(async ({ tx, afterCommit }) => {
    const ticket = await ticketService.findRawById(ticketId, tx);
    if (!ticket) throw new Error(`ticket ${ticketId} vanished mid-processing`);

    const message = await messageService.recordCustomerMessage(
      {
        ticket,
        customerId: conversation.customerId,
        body: input.body,
        externalMessageId: undefined,
      },
      tx,
    );

    await touchInbound(conversation, input, tx);

    await repository.updateInbound(
      inboundId,
      {
        status: 'processed',
        conversationId: conversation.id,
        ticketId: ticket.id,
        ticketMessageId: message.id,
        processedAt: new Date(),
      },
      tx,
    );

    afterCommit(async () => {
      await eventService.publish({
        type: DOMAIN_EVENT.messageCreated,
        ticket,
        data: {
          messageId: message.id,
          visibility: message.visibility,
          authorType: message.authorType,
          authorUserId: null,
          channel: input.channel,
        },
      });

      if (ticket.assignedToUserId) {
        await notificationService.notifyCustomerReply(ticket.assignedToUserId, ticket);
      }

      // The visitor's own widget echoes their message back, so the transcript
      // is the same whether they reloaded the page or not.
      if (input.channel === 'chat') {
        pushToVisitor(conversation.externalId, CHAT_EVENT.message, {
          conversationId: conversation.id,
          author: 'customer',
          body: input.body,
          createdAt: message.createdAt,
        });
      }
    });

    log.info('inbound channel message appended to ticket', {
      ticketId: ticket.id,
      channel: input.channel,
      inboundId,
    });

    return {
      status: 'processed' as const,
      conversationId: conversation.id,
      ticketId: ticket.id,
      ticketMessageId: message.id,
    };
  });

  await attachMedia(input, filed.ticketId, filed.ticketMessageId, conversation.customerId);
  return filed;
}

async function openTicket(
  inboundId: string,
  conversation: ChannelConversationRow,
  product: { id: string; name: string },
  input: FilingInput,
): Promise<InboundProcessResult> {
  // Ticket creation owns reference allocation, the opening message and the
  // opening audit row, so it runs outside the transaction below — exactly as the
  // inbound email path does — and the conversation is pointed at it afterwards.
  const created = await ticketService.create(
    {
      productId: product.id,
      subject: subjectFrom(input),
      body: input.body,
      channel: input.channel,
      customerId: conversation.customerId,
      sourceMetadata: {
        channel: input.channel,
        conversationId: conversation.id,
        externalId: conversation.externalId,
        from: input.fromIdentifier,
        ...(input.displayName ? { displayName: input.displayName } : {}),
      },
    },
    { kind: 'system', name: `${input.channel}.inbound` },
    { skipAccessCheck: true },
  );

  // The patch is kept so the in-memory row can be brought up to date with it.
  // Passing the pre-update row to the acknowledgement below would hand it a
  // conversation with no ticket and no reply window, and the acknowledgement
  // would be refused as if the window had closed — on a thread the customer had
  // written to seconds earlier.
  const patch = {
    ticketId: created.id,
    status: 'open' as const,
    ...windowPatch(input.channel),
  };

  await repository.updateConversation(conversation.id, patch);
  const opened = { ...conversation, ...patch };

  await repository.updateInbound(inboundId, {
    status: 'processed',
    conversationId: conversation.id,
    ticketId: created.id,
    processedAt: new Date(),
  });

  // Before the acknowledgement, so an agent opening the ticket because of it
  // finds the file already there.
  await attachMedia(input, created.id, await openingMessageId(created.id), conversation.customerId);

  await acknowledgeInChannel(input.channel, opened, created.reference, product.name);

  log.info('inbound channel message opened a ticket', {
    ticketId: created.id,
    reference: created.reference,
    channel: input.channel,
    inboundId,
  });

  return {
    status: 'processed',
    conversationId: conversation.id,
    ticketId: created.id,
    created: true,
  };
}

/**
 * Fetches a file that came with the message and puts it on the ticket.
 *
 * Runs **after** the message is committed, never inside its transaction: this
 * makes two HTTP calls to Meta and writes to object storage, and holding a
 * Postgres transaction open across all of that would be a lock held for a
 * network round trip. The consequence is deliberate and stated: a failure here
 * leaves the customer's words on the ticket without their file, which is far
 * better than losing the message because a download timed out.
 *
 * The provider **id** is resolved here rather than at webhook time because a
 * download URL lives about five minutes. The id lives a week, so a job retried
 * tomorrow still works — which is the whole reason the id is what gets stored.
 */
async function attachMedia(
  input: FilingInput,
  ticketId: string,
  messageId: string | undefined,
  customerId: string,
): Promise<void> {
  if (!input.media || !messageId) return;

  const media = input.media;

  try {
    const fetched = await fetchWhatsappMedia(media.providerMediaId, {
      maxBytes: env.ATTACHMENT_MAX_BYTES,
    });

    await attachmentService.storeInboundMedia({
      ticketId,
      messageId,
      customerId,
      filename: filenameFor(media, fetched.mimeType),
      contentType: media.mimeType ?? fetched.mimeType,
      bytes: fetched.bytes,
      checksum: fetched.sha256,
    });
  } catch (error) {
    // A file too large is the customer's problem to hear about, not an outage:
    // they are told in the thread, because otherwise they have sent something
    // into a void and are waiting for an answer about it.
    if (error instanceof MediaTooLargeError) {
      log.info('inbound media refused for size', { ticketId, fileSize: error.fileSize });
      await messageService.recordSystemMessage({
        ticketId,
        body: `The customer sent a ${media.kind} of ${Math.round(error.fileSize / 1024)}KB, which is over the ${Math.floor(error.maxBytes / 1024 / 1024)}MB limit and was not stored. Ask them to send it another way.`,
      });
      return;
    }

    // Everything else is ours: Meta being down, an expired id, storage
    // refusing. The message stands; the note is how an agent knows why there is
    // no file on a ticket that plainly mentions one.
    log.error('failed to attach inbound media', { ticketId, kind: media.kind, err: error });
    await messageService.recordSystemMessage({
      ticketId,
      body: `A ${media.kind} the customer sent could not be retrieved from WhatsApp. It may be requeued from the inbound backlog within seven days.`,
    });
  }
}

/**
 * The opening message a ticket was created with, so an attachment can hang off
 * the entry that mentions it rather than off the ticket alone.
 *
 * Read back rather than returned by `create`, because ticket creation answers
 * with a `TicketSummary` and widening it so this one caller can have a message
 * id would put a field on every ticket response in the system.
 */
async function openingMessageId(ticketId: string): Promise<string | undefined> {
  const thread = await messageService.customerVisibleThread(ticketId, 1);
  return thread[0]?.id;
}

/**
 * A name for a file that mostly arrives without one.
 *
 * Only documents carry a filename, and a customer-supplied one is untrusted —
 * it never becomes a storage key (`buildStorageKey` generates that) and it is
 * stripped to a basename here so a name like `../../etc/passwd` is just
 * `passwd` in the console.
 */
function filenameFor(media: NormalisedInboundMedia, fallbackMime: string): string {
  if (media.filename) {
    const base = media.filename.replace(/^.*[\\/]/, '').trim();
    if (base) return base.slice(0, 200);
  }

  const mime = media.mimeType ?? fallbackMime;
  const extension = mime.split('/')[1]?.split(';')[0] ?? 'bin';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  return `${media.kind}-${stamp}.${extension}`;
}

/** What the thread says when a file arrives with no caption. */
function describeMedia(media: NormalisedInboundMedia): string {
  if (media.kind === 'audio' && media.voice) return 'Sent a voice note.';
  if (media.kind === 'document') {
    return media.filename ? `Sent a document (${media.filename}).` : 'Sent a document.';
  }
  return `Sent ${media.kind === 'image' ? 'an image' : `a ${media.kind}`}.`;
}

/**
 * The reference, back down the channel the customer is standing in.
 *
 * The email path mails an acknowledgement; this is the same courtesy for a
 * channel where mailing one would be absurd. It is not a ticket message an
 * agent has to read past, only a system note saying it went — the same shape
 * the email acknowledgement records.
 */
async function acknowledgeInChannel(
  channel: ConversationChannel,
  conversation: ChannelConversationRow & { ticketId: string },
  reference: string,
  productName: string,
): Promise<void> {
  if (!env.SEND_TICKET_ACKNOWLEDGEMENT) return;

  const body = `Thank you for contacting ${productName} support. Your reference is ${reference}. An agent will be with you shortly.`;

  try {
    const result = await send(channel, conversation, body, 'ticket_acknowledgement', {
      ticketId: conversation.ticketId,
    });

    if (result.delivered) {
      await messageService.recordSystemMessage({
        ticketId: conversation.ticketId,
        body: `Acknowledgement sent over ${channel} with reference ${reference}.`,
      });
    }
  } catch (error) {
    // A provider outage must not lose a ticket that is already saved.
    log.error('failed to acknowledge in channel', {
      conversationId: conversation.id,
      channel,
      err: error,
    });
  }
}

/**
 * Finds or creates the customer behind a channel identity, then the thread.
 *
 * Matching is on `(channel, identifier)` and never on a name: two people called
 * Tendai are two customers, and a WhatsApp profile name is whatever its owner
 * last typed. The address-matching that the email path does has no equivalent
 * here — a phone number is not an email address, and guessing that they belong
 * to the same person is exactly the account-conflation the `sso` module refuses
 * to do for staff.
 */
async function resolveConversation(
  input: FilingInput,
  productId: string,
): Promise<ChannelConversationRow> {
  return withTransaction(async ({ tx }) => {
    const identity = await repository.findIdentity(input.channel, input.fromIdentifier, tx);

    const customerId =
      identity?.customerId ??
      (
        await customerService.createFromChannel(
          {
            fullName: input.displayName?.trim() || fallbackName(input),
            ...(input.channel === 'whatsapp' ? { phone: `+${input.fromIdentifier}` } : {}),
          },
          tx,
        )
      ).id;

    await repository.upsertIdentity(
      {
        customerId,
        channel: input.channel,
        identifier: input.fromIdentifier,
        displayName: input.displayName,
        lastSeenAt: new Date(),
      },
      tx,
    );

    const conversation = await repository.insertConversation(
      {
        channel: input.channel,
        externalId: input.externalId,
        productId,
        customerId,
      },
      tx,
    );

    return conversation;
  });
}

/** Stamps the thread with the customer having just written on it. */
async function touchInbound(
  conversation: ChannelConversationRow,
  input: FilingInput,
  exec: Executor,
): Promise<void> {
  await repository.updateConversation(
    conversation.id,
    { lastInboundAt: new Date(), status: 'open', ...windowPatch(input.channel) },
    exec,
  );
}

/**
 * When the provider will stop accepting a free-form reply on this thread.
 *
 * WhatsApp's rule, and only WhatsApp's: live chat has no window, so the column
 * stays null there rather than being given a meaningless date that the console
 * would then display.
 */
function windowPatch(channel: ConversationChannel): { windowExpiresAt?: Date } {
  if (channel !== 'whatsapp') return {};
  return {
    windowExpiresAt: new Date(Date.now() + env.WHATSAPP_SERVICE_WINDOW_HOURS * 3_600_000),
  };
}

/** A subject nobody wrote, from the first thing they did write. */
function subjectFrom(input: FilingInput): string {
  const firstLine = input.body.split('\n')[0]?.trim() ?? '';
  const trimmed = firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  return trimmed || `${input.channel === 'whatsapp' ? 'WhatsApp' : 'Live chat'} conversation`;
}

function fallbackName(input: FilingInput): string {
  return input.channel === 'whatsapp'
    ? `WhatsApp +${input.fromIdentifier}`
    : `Chat visitor ${input.fromIdentifier.slice(0, 8)}`;
}

/**
 * Which product a conversation lands in.
 *
 * Unlike inbound email, where the address written to names the product, one
 * WhatsApp number and one chat widget serve the whole business — so there is
 * nothing in the message that says which product it is about. Configuration
 * decides where it lands and routing rules move it from there. Failing loudly
 * when nothing is configured is deliberate, for the reason the email path gives:
 * guessing files a customer's query where the agents who can act on it will
 * never see it.
 */
async function resolveProduct(channel: ConversationChannel): Promise<{ id: string; name: string }> {
  const code =
    (channel === 'whatsapp' ? env.WHATSAPP_PRODUCT_CODE : env.CHAT_PRODUCT_CODE) ??
    env.DEFAULT_PRODUCT_CODE;

  if (code) {
    const product = await productService.findByCode(code);
    if (product) return product;
  }

  throw new Error(
    `no product configured for the ${channel} channel: set ${
      channel === 'whatsapp' ? 'WHATSAPP_PRODUCT_CODE' : 'CHAT_PRODUCT_CODE'
    } or DEFAULT_PRODUCT_CODE`,
  );
}

async function settle(
  inboundId: string,
  status: 'ignored' | 'failed',
  error: string,
): Promise<void> {
  await repository.updateInbound(inboundId, { status, error, processedAt: new Date() });
}

// -- outbound -----------------------------------------------------------------

/**
 * Sends an agent's public reply out on whatever channel the customer is on.
 *
 * This function is the point of Phase 8. Before it, `message.service` ended a
 * public reply with a call to the email service, which made "reply to the
 * customer" and "send an email" the same statement — and adding a channel would
 * have meant editing the most consequential branch in the system, the one that
 * decides whether an internal note leaves the building. Now the visibility
 * branch stays exactly where it was and this decides only the transport.
 *
 * Fails soft in every direction. The reply is already committed to the thread
 * and is the record of what the agent said; a provider that refuses it produces
 * a `failed` outbound row and a warning, never a rolled-back message or a 5xx
 * to the agent who wrote it.
 */
export async function dispatchReply(input: {
  ticket: TicketRow;
  message: TicketMessageRow;
  customer: { email: string | null; fullName: string };
  externalMessageId?: string | undefined;
}): Promise<DispatchResult> {
  const channel = input.ticket.channel;

  if (isConversationChannel(channel)) {
    const conversation = await repository.findConversationForTicket(input.ticket.id);

    if (!conversation) {
      // The thread this ticket belongs to is gone — a conversation closed by the
      // idle sweep after the ticket was raised, most likely. Email is the
      // fallback only if there is an address; otherwise the desk is told there
      // was nowhere to send it, which is better than pretending it went.
      return fallbackToEmail(input, `no open ${channel} conversation for this ticket`);
    }

    const result = await send(channel, conversation, input.message.body, 'ticket_reply', {
      ticketId: input.ticket.id,
      ticketMessageId: input.message.id,
    });

    return {
      channel,
      delivered: result.delivered,
      transport: channel,
      ...(result.error ? { reason: result.error } : {}),
    };
  }

  return fallbackToEmail(input);
}

async function fallbackToEmail(
  input: {
    ticket: TicketRow;
    message: TicketMessageRow;
    customer: { email: string | null; fullName: string };
    externalMessageId?: string | undefined;
  },
  reason?: string,
): Promise<DispatchResult> {
  if (!input.customer.email) {
    // A customer who has only ever used WhatsApp has no address, and there is no
    // address to invent. Recorded so the reply's failure to leave is visible
    // rather than silent.
    await repository.insertOutbound({
      channel: input.ticket.channel,
      ticketId: input.ticket.id,
      ticketMessageId: input.message.id,
      toIdentifier: '(none)',
      body: input.message.body,
      kind: 'ticket_reply',
      status: 'failed',
      error: reason ?? 'the customer has no email address and no open conversation',
    });

    log.warn('reply had nowhere to go', {
      ticketId: input.ticket.id,
      messageId: input.message.id,
      channel: input.ticket.channel,
    });

    return {
      channel: input.ticket.channel,
      delivered: false,
      transport: 'none',
      reason: reason ?? 'the customer has no email address and no open conversation',
    };
  }

  await emailService.sendTicketReply({
    ticket: input.ticket,
    message: input.message,
    to: input.customer.email,
    customerName: input.customer.fullName,
    externalMessageId: input.externalMessageId,
  });

  return {
    channel: input.ticket.channel,
    delivered: true,
    transport: 'email',
    ...(reason ? { reason } : {}),
  };
}

/**
 * One send, on one channel, recorded either way.
 *
 * The WhatsApp branch carries the only genuinely awkward rule in this phase:
 * outside the 24-hour customer-service window Meta refuses free-form text, and
 * the only thing that gets through is an approved template. So the window is
 * checked here and the template is used when it has closed — and when no
 * template is configured, the send is refused locally with a reason the agent
 * can read, rather than being posted to Meta so Meta can refuse it.
 */
async function send(
  channel: ConversationChannel,
  conversation: ChannelConversationRow,
  body: string,
  kind: 'ticket_reply' | 'ticket_acknowledgement',
  refs: { ticketId?: string | null; ticketMessageId?: string },
): Promise<{ delivered: boolean; error?: string }> {
  const record = async (
    status: 'sent' | 'failed',
    providerMessageId: string | null,
    error: string | null,
  ): Promise<void> => {
    await repository.insertOutbound({
      channel,
      conversationId: conversation.id,
      ticketId: refs.ticketId ?? null,
      ticketMessageId: refs.ticketMessageId ?? null,
      toIdentifier: conversation.externalId,
      body,
      kind,
      providerMessageId,
      status,
      error,
    });

    if (status === 'sent') {
      await repository.updateConversation(conversation.id, { lastOutboundAt: new Date() });
    }
  };

  if (channel === 'chat') {
    // Nothing to call: the transport is the socket the visitor is already
    // holding, and a visitor who has closed the tab reads the same message off
    // the transcript endpoint when they come back. So this is recorded as sent
    // whether or not anybody is listening — which is exactly what the email
    // path does, and for the same reason.
    pushToVisitor(conversation.externalId, CHAT_EVENT.message, {
      conversationId: conversation.id,
      author: 'agent',
      body,
      createdAt: new Date(),
    });

    await record('sent', null, null);
    return { delivered: true };
  }

  const windowOpen =
    conversation.windowExpiresAt !== null && conversation.windowExpiresAt.getTime() > Date.now();

  if (!windowOpen) {
    if (!env.WHATSAPP_REOPEN_TEMPLATE) {
      const error = `the ${env.WHATSAPP_SERVICE_WINDOW_HOURS}-hour WhatsApp reply window has closed and no re-open template is configured`;
      await record('failed', null, error);
      log.warn('whatsapp reply refused: window closed', { conversationId: conversation.id });
      return { delivered: false, error };
    }

    const templated = await sendWhatsappTemplate({
      to: conversation.externalId,
      templateName: env.WHATSAPP_REOPEN_TEMPLATE,
      languageCode: env.WHATSAPP_REOPEN_TEMPLATE_LANGUAGE,
      parameters: [body],
    });

    await record(
      templated.delivered ? 'sent' : 'failed',
      templated.messageId,
      templated.error ?? null,
    );
    return {
      delivered: templated.delivered,
      ...(templated.error ? { error: templated.error } : {}),
    };
  }

  const sent = await sendWhatsappText({
    to: conversation.externalId,
    body,
    kind,
  });

  await record(sent.delivered ? 'sent' : 'failed', sent.messageId, sent.error ?? null);
  return { delivered: sent.delivered, ...(sent.error ? { error: sent.error } : {}) };
}

/**
 * Pushes a frame into one visitor's room on the chat namespace.
 *
 * The room name and event catalogue come from `chat.types.ts` — a types import,
 * which the boundary rules allow and which keeps this module from depending on
 * the chat module's service. Nothing here can reach a staff room: the namespace
 * is a different one, and `broadcast` will not invent it.
 */
function pushToVisitor(conversationExternalId: string, event: string, payload: unknown): void {
  broadcast(CHAT_ROOM.conversation(conversationExternalId), event, payload, env.CHAT_NAMESPACE);
}

// -- reads --------------------------------------------------------------------

export async function list(
  filter: ListConversationsFilter,
  actor: Actor,
): Promise<{ items: ConversationView[]; hasMore: boolean }> {
  if (filter.productId) await productService.assertAccess(actor, filter.productId);

  const scope = await productService.scopeFor(actor);
  const productIds = scope.kind === 'all' ? null : scope.productIds;

  const rows = await repository.listConversations(
    { ...filter, limit: filter.limit + 1 },
    productIds,
  );

  const hasMore = rows.length > filter.limit;
  return { items: hasMore ? rows.slice(0, filter.limit) : rows, hasMore };
}

/**
 * Registers a channel identity and its thread before any message arrives.
 *
 * The live-chat widget needs this: a session is issued, and only then does the
 * visitor type. Everything the inbound path would have created lazily is created
 * eagerly here, so the first message takes the ordinary append-or-open branch
 * rather than a special case for "the conversation the session already made".
 */
export async function openConversation(input: {
  channel: ConversationChannel;
  externalId: string;
  productId: string;
  customerId: string;
  displayName?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}): Promise<ChannelConversationRow> {
  return withTransaction(async ({ tx }) => {
    await repository.upsertIdentity(
      {
        customerId: input.customerId,
        channel: input.channel,
        identifier: input.externalId,
        displayName: input.displayName ?? null,
        lastSeenAt: new Date(),
      },
      tx,
    );

    const conversation = await repository.insertConversation(
      {
        channel: input.channel,
        externalId: input.externalId,
        productId: input.productId,
        customerId: input.customerId,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
      tx,
    );

    return conversation;
  });
}

/** Ends a thread: the next message from this customer opens new work. */
export async function closeConversation(id: string): Promise<void> {
  await repository.updateConversation(id, { status: 'closed', ticketId: null });
}

/** The channel thread behind one ticket, for the console's header. */
export function forTicket(ticketId: string): Promise<ChannelConversationRow | undefined> {
  return repository.findConversationForTicket(ticketId);
}

export function findById(id: string): Promise<ChannelConversationRow | undefined> {
  return repository.findConversationById(id);
}

export function findByExternalId(
  channel: ConversationChannel,
  externalId: string,
): Promise<ChannelConversationRow | undefined> {
  return repository.findConversation(channel, externalId);
}

export function listUnprocessed(limit: number) {
  return repository.listUnprocessed(limit);
}

export function outboundForTicket(ticketId: string) {
  return repository.listOutboundForTicket(ticketId);
}

export function identitiesForCustomer(customerId: string) {
  return repository.identitiesForCustomer(customerId);
}

/** Called by the customer merge: a duplicate's channels follow it. */
export function reassignIdentities(
  fromCustomerId: string,
  toCustomerId: string,
  exec?: Executor,
): Promise<number> {
  return repository.reassignIdentities(fromCustomerId, toCustomerId, exec);
}

// -- housekeeping -------------------------------------------------------------

/**
 * Detaches threads nobody has written on for a while, so the next message opens
 * a new ticket instead of reopening a finished one.
 *
 * The row itself survives, because it holds the mapping a returning customer is
 * recognised by. Only the ticket pointer is dropped.
 */
export async function closeIdleConversations(): Promise<number> {
  const idleBefore = new Date(Date.now() - env.CONVERSATION_IDLE_HOURS * 3_600_000);
  const closed = await repository.closeIdleConversations(idleBefore);

  if (closed > 0) log.info('idle conversations closed', { closed });
  return closed;
}

/**
 * Reaps chat threads that were opened and abandoned without a word.
 *
 * Runs on the same sweep as the idle detach, one batch at a time. The cutoff is
 * twice the session TTL so nothing a live token could still reach is touched,
 * and the customer rows are offered to the customer module rather than deleted
 * here — it owns that table and the judgement about what is worth keeping.
 */
export async function reapAbandonedChats(limit = 500): Promise<number> {
  const before = new Date(Date.now() - env.CHAT_SESSION_TTL_MINUTES * 2 * 60_000);
  const customerIds = await repository.deleteAbandonedChatConversations(before, limit);
  if (customerIds.length === 0) return 0;

  const customers = await customerService.deleteOrphans(customerIds);
  log.info('abandoned chat threads reaped', { threads: customerIds.length, customers });

  return customerIds.length;
}

/** Called by the retention sweep; the envelopes are debris, the thread is not. */
export function purgeChannelLogs(before: Date): Promise<number> {
  return repository.purgeChannelLogs(before);
}
