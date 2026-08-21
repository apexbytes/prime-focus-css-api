import { randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import { env } from '../../config/index.js';
import { AppError } from '../../common/errors/index.js';
import { withTransaction, type Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { sendEmail, ticketAcknowledgementEmail } from '../../lib/resend/index.js';
import * as customerService from '../customer/customer.service.js';
import * as eventService from '../event/event.service.js';
import { DOMAIN_EVENT } from '../event/event.types.js';
import * as messageService from '../message/message.service.js';
import type { TicketMessageRow } from '../message/message.types.js';
import * as notificationService from '../notification/notification.service.js';
import * as productService from '../product/product.service.js';
import * as ticketService from '../ticket/ticket.service.js';
import type { TicketRow } from '../ticket/ticket.types.js';
import * as repository from './email.repository.js';
import type {
  FetchedInboundEmail,
  InboundProcessResult,
  InboundWebhookEvent,
} from './email.types.js';

const log = createModuleLogger('email:pipeline');

const client = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

// -- outbound -----------------------------------------------------------------

/**
 * Emails an agent's public reply to the customer.
 *
 * The subject carries the ticket reference and the headers carry the message id,
 * which together are how the customer's response finds its way back to this
 * thread — see `resolveTicket` below.
 */
export async function sendTicketReply(input: {
  ticket: TicketRow;
  message: TicketMessageRow;
  to: string;
  customerName: string;
  externalMessageId?: string | undefined;
}): Promise<void> {
  const subject = `[${input.ticket.reference}] ${input.ticket.subject}`;

  const result = await sendEmail({
    to: input.to,
    kind: 'ticket_reply',
    subject,
    text: input.message.body,
    html:
      input.message.bodyHtml ?? `<p>${escapeHtml(input.message.body).replace(/\n/g, '<br />')}</p>`,
    ...(input.externalMessageId ? { messageId: input.externalMessageId } : {}),
  });

  await repository.insertOutbound({
    ticketId: input.ticket.id,
    ticketMessageId: input.message.id,
    toAddress: input.to,
    subject,
    kind: 'ticket_reply',
    providerMessageId: result.messageId,
    status: result.delivered ? 'sent' : 'failed',
    error: result.delivered ? null : 'provider rejected the message',
  });

  if (!result.delivered) {
    log.error('ticket reply could not be delivered', {
      ticketId: input.ticket.id,
      messageId: input.message.id,
    });
  }
}

/**
 * Tells the customer their query is logged, and returns the Message-ID it was
 * sent with.
 *
 * That id matters: it is recorded against the ticket so a customer replying to
 * *this* email threads back onto the same ticket by header, without depending on
 * their mail client preserving the subject line.
 *
 * Returns null when acknowledgements are switched off or delivery failed — the
 * caller must not record an id that never went anywhere.
 */
export async function sendTicketAcknowledgement(input: {
  ticket: TicketRow;
  to: string;
  customerName: string;
  productName: string;
  body: string;
}): Promise<string | null> {
  if (!env.SEND_TICKET_ACKNOWLEDGEMENT) return null;

  const messageId = `<${randomUUID()}@${env.SUPPORT_INBOX_DOMAIN}>`;
  const rendered = ticketAcknowledgementEmail({
    fullName: input.customerName,
    reference: input.ticket.reference,
    subject: input.ticket.subject,
    productName: input.productName,
    body: input.body,
  });

  const result = await sendEmail({
    ...rendered,
    to: input.to,
    kind: 'ticket_acknowledgement',
    messageId,
    // Threads under the customer's original email in their own client.
    ...(typeof (input.ticket.sourceMetadata as { messageId?: string } | null)?.messageId ===
    'string'
      ? { inReplyTo: (input.ticket.sourceMetadata as { messageId: string }).messageId }
      : {}),
  });

  await repository.insertOutbound({
    ticketId: input.ticket.id,
    toAddress: input.to,
    subject: rendered.subject,
    kind: 'ticket_acknowledgement',
    providerMessageId: result.messageId,
    status: result.delivered ? 'sent' : 'failed',
    error: result.delivered ? null : 'provider rejected the message',
  });

  if (!result.delivered) {
    log.error('ticket acknowledgement could not be delivered', {
      ticketId: input.ticket.id,
      reference: input.ticket.reference,
    });
    return null;
  }

  return messageId;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function outboundForTicket(ticketId: string) {
  return repository.listOutboundForTicket(ticketId);
}

// -- inbound ------------------------------------------------------------------

/**
 * Records an inbound email and returns its row id.
 *
 * Persist-then-process: the webhook stores what it was told and answers 200
 * straight away, because a provider that gets a 5xx will retry and a slow handler
 * will time out. The row is the durable queue — if processing dies the email is
 * still here, and Phase 4 turns the retry into a scheduled job.
 */
export async function recordInbound(
  event: InboundWebhookEvent,
): Promise<{ id: string; duplicate: boolean }> {
  const existing = await repository.findInboundByProviderId(event.data.email_id);
  if (existing) {
    log.info('duplicate inbound webhook ignored', { providerEmailId: event.data.email_id });
    return { id: existing.id, duplicate: true };
  }

  const row = await repository.insertInbound({
    providerEmailId: event.data.email_id,
    messageId: event.data.message_id ?? null,
    fromAddress: parseAddress(event.data.from),
    toAddresses: [...(event.data.received_for ?? []), ...event.data.to].map(parseAddress),
    subject: event.data.subject ?? null,
    payload: event,
  });

  // Lost the race with a concurrent redelivery; the other one owns it.
  if (!row) {
    const settled = await repository.findInboundByProviderId(event.data.email_id);
    return { id: settled?.id ?? '', duplicate: true };
  }

  return { id: row.id, duplicate: false };
}

/** `Display Name <someone@example.com>` becomes `someone@example.com`. */
function parseAddress(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match?.[1] ?? value).trim().toLowerCase();
}

/**
 * Test seam. The webhook carries no body, so the only way to exercise the
 * pipeline without a live Resend account is to substitute the retrieval step.
 */
let fetcher: (providerEmailId: string) => Promise<FetchedInboundEmail> = fetchFullEmail;

export function __setInboundFetcher(
  override: ((providerEmailId: string) => Promise<FetchedInboundEmail>) | null,
): void {
  fetcher = override ?? fetchFullEmail;
}

/**
 * Turns a recorded inbound email into a ticket message.
 *
 * Idempotent: re-running for an already-processed row is a no-op, which is what
 * makes the retry path safe.
 */
export async function processInbound(inboundId: string): Promise<InboundProcessResult> {
  const inbound = await repository.findInboundById(inboundId);
  if (!inbound) throw AppError.notFound('Inbound email not found');

  if (inbound.status === 'processed') {
    return { status: 'processed', ...(inbound.ticketId ? { ticketId: inbound.ticketId } : {}) };
  }

  try {
    const fetched = await fetcher(inbound.providerEmailId);
    const body = (fetched.text ?? stripHtml(fetched.html ?? '')).trim();

    if (!body) {
      await repository.updateInbound(inbound.id, {
        status: 'ignored',
        error: 'no readable body',
        processedAt: new Date(),
      });
      return { status: 'ignored', reason: 'no readable body' };
    }

    // Bounces and vacation replies must not open tickets or, worse, start a loop
    // of auto-replies between two robots.
    const auto = detectAutoReply(fetched.headers, inbound.subject);
    if (auto) {
      await repository.updateInbound(inbound.id, {
        status: 'ignored',
        error: auto,
        processedAt: new Date(),
      });
      log.info('inbound email ignored', { inboundId: inbound.id, reason: auto });
      return { status: 'ignored', reason: auto };
    }

    if (
      inbound.messageId &&
      (await messageService.existsWithExternalMessageId(inbound.messageId))
    ) {
      await repository.updateInbound(inbound.id, {
        status: 'ignored',
        error: 'message already filed',
        processedAt: new Date(),
      });
      return { status: 'ignored', reason: 'message already filed' };
    }

    return await fileInbound(inbound.id, {
      fromAddress: inbound.fromAddress,
      toAddresses: inbound.toAddresses,
      subject: inbound.subject ?? fetched.subject ?? '(no subject)',
      body,
      html: fetched.html,
      messageId: inbound.messageId,
      headers: fetched.headers,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    await repository.updateInbound(inbound.id, { status: 'failed', error: reason });
    log.error('failed to process inbound email', { inboundId: inbound.id, err: error });
    return { status: 'failed', reason };
  }
}

async function fetchFullEmail(providerEmailId: string): Promise<FetchedInboundEmail> {
  if (!client) {
    // Without an API key there is nothing to fetch from. Tests inject the body
    // through `__setInboundFetcher`.
    throw new Error('RESEND_API_KEY is required to retrieve inbound email bodies');
  }

  const response = await client.emails.receiving.get(providerEmailId);
  if (response.error) {
    throw new Error(`${response.error.name}: ${response.error.message}`);
  }

  const data = response.data as unknown as {
    text?: string | null;
    html?: string | null;
    headers?: Record<string, string> | null;
    subject?: string | null;
    from?: string | null;
  } | null;

  return {
    text: data?.text ?? null,
    html: data?.html ?? null,
    headers: data?.headers ?? null,
    subject: data?.subject ?? null,
    from: data?.from ?? null,
  };
}

/** Headers that mark a message as machine-generated. */
function detectAutoReply(
  headers: Record<string, string> | null,
  subject: string | null,
): string | null {
  const lower = Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );

  if (lower['auto-submitted'] && lower['auto-submitted'] !== 'no') return 'auto-submitted header';
  if (lower['x-autoreply'] || lower['x-autorespond']) return 'auto-reply header';
  if (lower['precedence'] && ['bulk', 'junk', 'list'].includes(lower['precedence'].toLowerCase())) {
    return `precedence: ${lower['precedence']}`;
  }
  if (lower['x-failed-recipients'] || lower['return-path']?.includes('mailer-daemon')) {
    return 'bounce notification';
  }
  if (
    subject &&
    /^(auto(matic)?[ -]?reply|out of office|undeliverable|mail delivery)/i.test(subject)
  ) {
    return 'auto-reply subject';
  }

  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

interface FilingInput {
  fromAddress: string;
  toAddresses: string[];
  subject: string;
  body: string;
  html: string | null;
  messageId: string | null;
  headers: Record<string, string> | null;
}

async function fileInbound(inboundId: string, input: FilingInput): Promise<InboundProcessResult> {
  const existingTicketId = await resolveTicket(input);

  if (existingTicketId) {
    return withTransaction(async ({ tx, afterCommit }) => {
      const { customer } = await customerService.findOrCreateFromEmail(
        { email: input.fromAddress, fullName: displayNameFrom(input.headers) },
        tx,
      );

      const ticket = await ticketService.findRawById(existingTicketId, tx);
      if (!ticket) throw new Error(`ticket ${existingTicketId} vanished mid-processing`);

      const message = await messageService.recordCustomerMessage(
        {
          ticket,
          customerId: customer.id,
          body: input.body,
          bodyHtml: input.html ?? undefined,
          externalMessageId: input.messageId ?? undefined,
          inReplyTo: input.headers?.['in-reply-to'] ?? undefined,
        },
        tx,
      );

      await repository.updateInbound(
        inboundId,
        {
          status: 'processed',
          ticketId: ticket.id,
          ticketMessageId: message.id,
          processedAt: new Date(),
        },
        tx,
      );

      afterCommit(async () => {
        // The customer replying is the event a partner system most wants: it is
        // what turns a ticket the agent thought finished back into work.
        await eventService.publish({
          type: DOMAIN_EVENT.messageCreated,
          ticket,
          data: {
            messageId: message.id,
            visibility: message.visibility,
            authorType: message.authorType,
            authorUserId: null,
          },
        });

        if (ticket.assignedToUserId) {
          await notificationService.notifyCustomerReply(ticket.assignedToUserId, ticket);
        }
      });

      log.info('inbound email appended to ticket', { ticketId: ticket.id, inboundId });
      return { status: 'processed', ticketId: ticket.id, ticketMessageId: message.id };
    });
  }

  // A new conversation. The ticket service owns creation (reference allocation,
  // the opening audit entry), so it is called outside the transaction below and
  // the inbound row is updated afterwards.
  const product = await resolveProduct(input.toAddresses);

  // Ticket creation writes the opening message itself, carrying the Message-ID
  // so the customer's next reply threads back onto this ticket.
  const created = await ticketService.create(
    {
      productId: product.id,
      subject: input.subject,
      body: input.body,
      bodyHtml: input.html ?? undefined,
      externalMessageId: input.messageId ?? undefined,
      channel: 'email',
      customerEmail: input.fromAddress,
      customerName: displayNameFrom(input.headers),
      sourceMetadata: {
        messageId: input.messageId,
        from: input.fromAddress,
        to: input.toAddresses,
      },
    },
    { kind: 'system', name: 'email.inbound' },
    { skipAccessCheck: true },
  );

  await repository.updateInbound(inboundId, {
    status: 'processed',
    ticketId: created.id,
    processedAt: new Date(),
  });

  log.info('inbound email opened a ticket', {
    ticketId: created.id,
    reference: created.reference,
    inboundId,
  });

  return { status: 'processed', ticketId: created.id, created: true };
}

/**
 * Finds the ticket a reply belongs to, in order of reliability:
 *
 *  1. `In-Reply-To` / `References` matched against a message we sent — exact.
 *  2. The reference in the subject line — survives clients that rewrite headers,
 *     and is why the reference is in the subject at all.
 *
 * No match means a new conversation.
 */
async function resolveTicket(input: FilingInput): Promise<string | undefined> {
  const headerIds = [
    input.headers?.['in-reply-to'],
    ...(input.headers?.references ?? '').split(/\s+/),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of headerIds) {
    const ticketId = await messageService.findTicketIdByExternalMessageId(candidate.trim());
    if (ticketId) return ticketId;
  }

  const referenceMatch = new RegExp(`${env.TICKET_REFERENCE_PREFIX}-\\d{4}-\\d{6}`, 'i').exec(
    input.subject,
  );

  if (referenceMatch) {
    const ticket = await ticketService.findByReference(referenceMatch[0].toUpperCase());
    if (ticket) return ticket.id;
  }

  return undefined;
}

/** Which product an inbound email belongs to, by the address it was sent to. */
async function resolveProduct(toAddresses: string[]) {
  for (const address of toAddresses) {
    const product = await productService.findBySupportEmail(address);
    if (product) return product;
  }

  if (env.DEFAULT_PRODUCT_CODE) {
    const fallback = await productService.findByCode(env.DEFAULT_PRODUCT_CODE);
    if (fallback) return fallback;
  }

  // Guessing would file a customer's query under the wrong product and hide it
  // from the agents who can act on it. Failing loudly is the safer outcome: the
  // row stays `failed` and can be retried once a product is configured.
  throw new Error(
    `no product matches ${toAddresses.join(', ')} and DEFAULT_PRODUCT_CODE is not set`,
  );
}

function displayNameFrom(headers: Record<string, string> | null): string | undefined {
  const from = headers?.from;
  if (!from) return undefined;

  const match = /^\s*"?([^"<]+?)"?\s*</.exec(from);
  return match?.[1]?.trim() || undefined;
}

export function listUnprocessed(limit: number) {
  return repository.listUnprocessed(limit);
}

/** Delivery, bounce and complaint events. */
export async function recordDeliveryEvent(input: {
  providerMessageId: string | null;
  event: string;
  payload: unknown;
  occurredAt: Date;
}): Promise<void> {
  await repository.insertEvent({
    providerMessageId: input.providerMessageId,
    event: input.event,
    payload: input.payload,
    occurredAt: input.occurredAt,
  });
}

export type { Executor };
