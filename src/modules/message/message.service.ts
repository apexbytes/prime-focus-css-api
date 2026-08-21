import { randomUUID } from 'node:crypto';
import { env } from '../../config/index.js';
import { AppError } from '../../common/errors/index.js';
import { isUserActor, type Actor } from '../../common/types/actor.js';
import { withTransaction, type Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as auditService from '../audit/audit.service.js';
import * as customerService from '../customer/customer.service.js';
import * as emailService from '../email/email.service.js';
import * as eventService from '../event/event.service.js';
import { DOMAIN_EVENT } from '../event/event.types.js';
import * as notificationService from '../notification/notification.service.js';
import * as ticketService from '../ticket/ticket.service.js';
import * as userService from '../user/user.service.js';
import type { TicketRow } from '../ticket/ticket.types.js';
import type { MessageVisibility, TicketMessageRow } from './message.model.js';
import * as repository from './message.repository.js';

const log = createModuleLogger('message');

/** Mentions are `@email@domain`, matching what the console inserts. */
const MENTION_PATTERN = /@([\w.+-]+@[\w-]+\.[\w.-]+)/g;

export async function listForTicket(
  ticketId: string,
  options: { includeInternal?: boolean | undefined; cursor?: string | undefined; limit: number },
  actor: Actor,
) {
  await ticketService.requireAccessible(ticketId, actor);

  // Only staff may see internal notes; there is no customer-facing caller in
  // Phase 3, but the flag is explicit so that stays true when there is one.
  const includeInternal = options.includeInternal !== false && actor.kind !== 'system';

  const rows = await repository.listForTicket(
    ticketId,
    {
      includeInternal,
      limit: options.limit + 1,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    },
    undefined,
  );

  const hasMore = rows.length > options.limit;
  return { items: hasMore ? rows.slice(0, options.limit) : rows, hasMore };
}

export interface PostReplyInput {
  ticketId: string;
  body: string;
  bodyHtml?: string | undefined;
  visibility: MessageVisibility;
}

/**
 * An agent's reply or internal note.
 *
 * A `public` message is emailed to the customer; an `internal` one never leaves
 * the system. That branch is the most consequential line in this module — an
 * internal note reaching a customer would be a serious breach — so the outbound
 * send is gated on visibility here and asserted by tests.
 */
export async function postAgentMessage(
  input: PostReplyInput,
  actor: Actor,
): Promise<TicketMessageRow> {
  if (!isUserActor(actor)) {
    throw AppError.forbidden('Only a signed-in user can post to a ticket');
  }

  const ticket = await ticketService.requireAccessible(input.ticketId, actor);
  const customer = await customerService.requireById(ticket.customerId);

  const message = await withTransaction(async ({ tx, afterCommit }) => {
    // Generated up front so the same id goes into the row and the email header,
    // which is what lets the customer's reply thread back onto this ticket.
    const externalMessageId =
      input.visibility === 'public' ? `<${randomUUID()}@${env.SUPPORT_INBOX_DOMAIN}>` : null;

    const row = await repository.insert(
      {
        ticketId: ticket.id,
        authorType: 'agent',
        authorUserId: actor.id,
        visibility: input.visibility,
        body: input.body,
        bodyHtml: input.bodyHtml ?? null,
        externalMessageId,
      },
      tx,
    );

    if (input.visibility === 'public') {
      const isFirst = await ticketService.registerAgentReply(ticket, tx);
      if (isFirst) await repository.markFirstResponse(row.id, tx);
    }

    await auditService.record(
      {
        action: input.visibility === 'public' ? 'ticket.replied' : 'ticket.note_added',
        entityType: 'ticket',
        entityId: ticket.id,
        after: { messageId: row.id, visibility: row.visibility },
      },
      actor,
      tx,
    );

    afterCommit(async () => {
      // Metadata only — never the body. An internal note is agent-only, and a
      // webhook is an egress its author never saw; `visibility` travels with
      // the event so a receiver can tell the two apart.
      await eventService.publish({
        type: DOMAIN_EVENT.messageCreated,
        ticket,
        data: {
          messageId: row.id,
          visibility: row.visibility,
          authorType: row.authorType,
          authorUserId: row.authorUserId,
        },
      });

      await notifyMentions(input.body, ticket, actor, row);

      if (input.visibility === 'public') {
        await emailService.sendTicketReply({
          ticket,
          message: row,
          to: customer.email,
          customerName: customer.fullName,
          externalMessageId: externalMessageId ?? undefined,
        });
      }
    });

    return row;
  });

  log.info('agent message posted', {
    ticketId: ticket.id,
    messageId: message.id,
    visibility: message.visibility,
  });

  return message;
}

/** @-mentions in an internal note pull a colleague in without reassigning. */
async function notifyMentions(
  body: string,
  ticket: TicketRow,
  actor: Actor,
  message: TicketMessageRow,
): Promise<void> {
  const emails = [...body.matchAll(MENTION_PATTERN)].map((match) => match[1]).filter(Boolean);
  if (emails.length === 0) return;

  const authorName = isUserActor(actor) ? actor.fullName : 'A colleague';

  for (const email of new Set(emails)) {
    try {
      const mentioned = await mentionedUser(email as string);
      if (!mentioned || mentioned === (isUserActor(actor) ? actor.id : null)) continue;

      await notificationService.notifyMention(mentioned, ticket, authorName);
    } catch (error) {
      log.warn('failed to notify a mention', { messageId: message.id, err: error });
    }
  }
}

async function mentionedUser(email: string): Promise<string | null> {
  const user = await userService.findByEmail(email);
  return user && user.status === 'active' ? user.id : null;
}

/**
 * A customer's inbound reply. Called by the email pipeline, which has already
 * resolved the ticket, so there is no actor and no access check — the customer is
 * replying to their own thread.
 */
export async function recordCustomerMessage(
  input: {
    ticket: TicketRow;
    customerId: string;
    body: string;
    bodyHtml?: string | undefined;
    externalMessageId?: string | undefined;
    inReplyTo?: string | undefined;
  },
  exec: Executor,
): Promise<TicketMessageRow> {
  const row = await repository.insert(
    {
      ticketId: input.ticket.id,
      authorType: 'customer',
      authorCustomerId: input.customerId,
      // A customer message is always public: there is no way for a customer to
      // write an internal note.
      visibility: 'public',
      body: input.body,
      bodyHtml: input.bodyHtml ?? null,
      externalMessageId: input.externalMessageId ?? null,
      inReplyTo: input.inReplyTo ?? null,
    },
    exec,
  );

  await ticketService.registerCustomerReply(input.ticket, exec);
  return row;
}

/**
 * The customer's description, written as the first entry in the thread.
 *
 * Recorded as `customer` regardless of who typed it: when an agent raises a
 * ticket after a phone call, or a product system raises one via the API, the body
 * is still the customer's account of the problem, and a thread that opens with an
 * `agent` message reads as though nobody reported anything.
 */
export async function recordOpeningMessage(
  input: {
    ticketId: string;
    customerId: string;
    body: string;
    bodyHtml?: string | undefined;
    externalMessageId?: string | undefined;
  },
  exec: Executor,
): Promise<TicketMessageRow> {
  return repository.insert(
    {
      ticketId: input.ticketId,
      authorType: 'customer',
      authorCustomerId: input.customerId,
      visibility: 'public',
      body: input.body,
      bodyHtml: input.bodyHtml ?? null,
      externalMessageId: input.externalMessageId ?? null,
    },
    exec,
  );
}

/**
 * System entries: status changes worth showing in the thread, SLA notices, and
 * the record of an acknowledgement having been sent.
 *
 * Always `internal`, so these never reach a customer. `externalMessageId` lets an
 * automated email we sent be threaded against later: a customer replying to it
 * arrives with that id in `In-Reply-To`.
 */
export async function recordSystemMessage(
  input: {
    ticketId: string;
    body: string;
    externalMessageId?: string | undefined;
  },
  exec?: Executor,
): Promise<TicketMessageRow> {
  return repository.insert(
    {
      ticketId: input.ticketId,
      authorType: 'system',
      visibility: 'internal',
      body: input.body,
      externalMessageId: input.externalMessageId ?? null,
    },
    exec,
  );
}

export function findTicketIdByExternalMessageId(
  externalMessageId: string,
  exec?: Executor,
): Promise<string | undefined> {
  return repository.findTicketIdByExternalMessageId(externalMessageId, exec);
}

export function existsWithExternalMessageId(
  externalMessageId: string,
  exec?: Executor,
): Promise<boolean> {
  return repository.existsWithExternalMessageId(externalMessageId, exec);
}

// -- retention ---------------------------------------------------------------

/**
 * Strips the words out of every message on these tickets, keeping the thread's
 * shape. Called by the retention sweep; there is no request path to it.
 */
export function anonymiseForTickets(ticketIds: readonly string[]): Promise<number> {
  return repository.anonymiseForTickets(ticketIds);
}
