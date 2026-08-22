import { env } from '../../config/index.js';
import { AppError } from '../../common/errors/index.js';
import { isUserActor, type Actor } from '../../common/types/actor.js';
import { withTransaction, type Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { enqueue, JOB } from '../../lib/queue/index.js';
import * as auditService from '../audit/audit.service.js';
import * as categoryService from '../category/category.service.js';
import * as customerService from '../customer/customer.service.js';
import * as emailService from '../email/email.service.js';
import * as eventService from '../event/event.service.js';
import { DOMAIN_EVENT } from '../event/event.types.js';
// Cyclic with message.service by design (see the note in user.service): a ticket
// and its opening message must commit together, and replies need the ticket.
import * as messageService from '../message/message.service.js';
import * as notificationService from '../notification/notification.service.js';
import * as productService from '../product/product.service.js';
import * as slaService from '../sla/sla.service.js';
import * as tagService from '../tag/tag.service.js';
import * as userService from '../user/user.service.js';
import type { TicketChannel, TicketPriority, TicketRow, TicketStatus } from './ticket.model.js';
import * as repository from './ticket.repository.js';
import { assertTransition, timestampsForStatus } from './ticket.status.js';
import type { ListTicketsFilter, TicketSummary } from './ticket.types.js';

const log = createModuleLogger('ticket');

/** Translates the actor's product scope into the argument every read needs. */
async function scopedProductIds(actor: Actor): Promise<string[] | null> {
  const scope = await productService.scopeFor(actor);
  return scope.kind === 'all' ? null : scope.productIds;
}

export async function list(
  filter: ListTicketsFilter,
  actor: Actor,
): Promise<{ items: TicketSummary[]; hasMore: boolean }> {
  const productIds = await scopedProductIds(actor);

  // A caller-supplied productId still has to be inside their scope, otherwise
  // the filter would be a way to read another product's queue.
  if (filter.productId) await productService.assertAccess(actor, filter.productId);

  const rows = await repository.list({ ...filter, limit: filter.limit + 1 }, productIds);
  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;

  const tags = await tagService.forTickets(page.map((row) => row.id));
  return {
    items: page.map((row) => ({ ...row, tags: tags.get(row.id) ?? [] })),
    hasMore,
  };
}

export async function get(id: string, actor: Actor): Promise<TicketSummary> {
  const row = await repository.findById(id);
  if (!row) throw AppError.notFound('Ticket not found');

  // 404 rather than 403 outside the caller's products: existence is information.
  await productService.assertAccess(actor, row.productId);

  return { ...row, tags: (await tagService.forTicket(id)).map((tag) => tag.name) };
}

/** Raw row plus an access check, for other modules that need the ticket itself. */
export async function requireAccessible(id: string, actor: Actor): Promise<TicketRow> {
  const ticket = await repository.findRawById(id);
  if (!ticket) throw AppError.notFound('Ticket not found');
  await productService.assertAccess(actor, ticket.productId);
  return ticket;
}

export interface CreateTicketInput {
  productId: string;
  subject: string;
  /** The customer's opening message; stored as the first ticket message. */
  body: string;
  channel: TicketChannel;
  priority?: TicketPriority | undefined;
  categoryId?: string | undefined;
  /** Either an existing customer, or enough to find or create one. */
  customerId?: string | undefined;
  customerEmail?: string | undefined;
  customerName?: string | undefined;
  tags?: string[] | undefined;
  assignedToUserId?: string | undefined;
  sourceMetadata?: Record<string, unknown> | undefined;
  /** HTML alternative for the opening message, when the source had one. */
  bodyHtml?: string | undefined;
  /** Message-ID of the email that opened this ticket, for threading replies. */
  externalMessageId?: string | undefined;
}

/**
 * Creates a ticket and its opening message atomically.
 *
 * The message is written here rather than by the message module because a ticket
 * with no first message is a broken record, and the two have to commit together.
 */
export async function create(
  input: CreateTicketInput,
  actor: Actor,
  options: { skipAccessCheck?: boolean } = {},
): Promise<TicketSummary> {
  const product = await productService.requireById(input.productId);
  if (!options.skipAccessCheck) {
    await productService.assertAccess(actor, product.id);
  }

  if (input.categoryId) {
    await categoryService.requireForProduct(input.categoryId, product.id);
  }
  if (input.assignedToUserId) {
    await userService.requireById(input.assignedToUserId);
  }

  const ticket = await withTransaction(async ({ tx, afterCommit }) => {
    const customer = input.customerId
      ? await customerService.requireById(input.customerId)
      : (
          await customerService.findOrCreateFromEmail(
            {
              email: requireCustomerEmail(input),
              fullName: input.customerName,
            },
            tx,
          )
        ).customer;

    const reference = await repository.nextReference(env.TICKET_REFERENCE_PREFIX, tx);

    const row = await repository.insert(
      {
        reference,
        customerId: customer.id,
        productId: product.id,
        categoryId: input.categoryId ?? null,
        subject: input.subject,
        channel: input.channel,
        status: input.assignedToUserId ? 'open' : 'new',
        ...(input.priority ? { priority: input.priority } : {}),
        assignedToUserId: input.assignedToUserId ?? null,
        teamId: product.defaultTeamId,
        sourceMetadata: input.sourceMetadata ?? null,
        createdByUserId: isUserActor(actor) ? actor.id : null,
        lastCustomerReplyAt: new Date(),
      },
      tx,
    );

    // The customer's description is the first entry in the thread. It commits
    // with the ticket: a ticket whose opening message is missing is a broken
    // record, and callers are required to supply a body.
    await messageService.recordOpeningMessage(
      {
        ticketId: row.id,
        customerId: customer.id,
        body: input.body,
        bodyHtml: input.bodyHtml,
        externalMessageId: input.externalMessageId,
      },
      tx,
    );

    for (const name of input.tags ?? []) {
      const tag = await tagService.findOrCreate(name, actor, tx);
      await tagService.attach(row.id, tag.id, tx);
    }

    if (input.assignedToUserId) {
      await repository.recordAssignment(
        {
          ticketId: row.id,
          toUserId: input.assignedToUserId,
          assignedByUserId: isUserActor(actor) ? actor.id : null,
          reason: 'assigned at creation',
        },
        tx,
      );
    }

    // In the transaction, not in the triage job: a ticket whose targets went
    // missing because the queue was down would look permanently on time, and
    // nothing would ever escalate it.
    await slaService.applyTargetsForNewTicket(
      {
        id: row.id,
        productId: row.productId,
        priority: row.priority,
        createdAt: row.createdAt,
      },
      tx,
    );

    await auditService.record(
      {
        action: 'ticket.created',
        entityType: 'ticket',
        entityId: row.id,
        after: {
          reference: row.reference,
          productId: row.productId,
          channel: row.channel,
          priority: row.priority,
        },
      },
      actor,
      tx,
    );

    afterCommit(async () => {
      // Announced to the console and to any subscribed product system. After
      // commit, because there is no way to retract an event about a ticket that
      // then rolled back.
      await eventService.publish({ type: DOMAIN_EVENT.ticketCreated, ticket: row });

      if (input.assignedToUserId) {
        await notificationService.notifyAssignment(input.assignedToUserId, row);
      }

      await acknowledgeToCustomer(row, product.name, customer, input);

      // Routing runs after commit so a slow rule set never delays the response
      // to the customer. `autoassign` leaves an already-owned ticket alone, so a
      // ticket raised with an explicit assignee is not reassigned.
      await enqueue(JOB.ticketTriage, { ticketId: row.id });
    });

    return row;
  });

  log.info('ticket created', {
    ticketId: ticket.id,
    reference: ticket.reference,
    channel: ticket.channel,
  });

  return get(ticket.id, actor);
}

/**
 * Channels the customer is not already talking to a human on.
 *
 * `agent` is excluded deliberately: a ticket raised during a phone call would
 * email a confirmation to someone who has just hung up after being told their
 * reference out loud. `chat` and `whatsapp` are excluded for the same reason and
 * get their acknowledgement in the thread they are standing in — see
 * `conversation.service.acknowledgeInChannel` — because emailing a reference to
 * somebody mid-conversation on WhatsApp is the same mistake in a new channel.
 */
const ACKNOWLEDGED_CHANNELS = new Set<TicketChannel>(['email', 'web_form', 'api']);

/**
 * Emails the customer their reference, and records the send in the thread so an
 * agent can see it happened — and so a reply to that email threads by header.
 *
 * Runs after commit and swallows its own failures: a mail provider outage must
 * not lose a ticket that is already saved.
 */
async function acknowledgeToCustomer(
  ticket: TicketRow,
  productName: string,
  customer: { email: string | null; fullName: string },
  input: CreateTicketInput,
): Promise<void> {
  if (!ACKNOWLEDGED_CHANNELS.has(ticket.channel)) return;
  // Since Phase 8 a customer may have no address at all. On the channels in the
  // set above one always does — they are the channels an address arrives on —
  // but the type says otherwise and pretending it does not would be the kind of
  // assumption that becomes a crash the first time a product system raises a
  // ticket for a WhatsApp customer by id.
  if (!customer.email) return;

  try {
    const messageId = await emailService.sendTicketAcknowledgement({
      ticket,
      to: customer.email,
      customerName: customer.fullName,
      productName,
      body: input.body,
    });

    if (messageId) {
      await messageService.recordSystemMessage({
        ticketId: ticket.id,
        body: `Acknowledgement emailed to the customer with reference ${ticket.reference}.`,
        externalMessageId: messageId,
      });
    }
  } catch (error) {
    log.error('failed to acknowledge ticket to customer', {
      ticketId: ticket.id,
      err: error,
    });
  }
}

function requireCustomerEmail(input: CreateTicketInput): string {
  if (!input.customerEmail) {
    throw AppError.validation('A customer is required', {
      details: [{ field: 'customerEmail', issue: 'provide customerId or customerEmail' }],
    });
  }
  return input.customerEmail;
}

export async function updateFields(
  id: string,
  patch: {
    subject?: string | undefined;
    priority?: TicketPriority | undefined;
    categoryId?: string | null | undefined;
    status?: TicketStatus | undefined;
    teamId?: string | null | undefined;
  },
  actor: Actor,
): Promise<TicketSummary> {
  const before = await requireAccessible(id, actor);

  if (patch.categoryId) {
    await categoryService.requireForProduct(patch.categoryId, before.productId);
  }
  if (patch.status) {
    assertTransition(before.status, patch.status);
  }

  await withTransaction(async ({ tx, afterCommit }) => {
    const row = await repository.update(
      id,
      {
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        ...(patch.teamId !== undefined ? { teamId: patch.teamId } : {}),
        ...(patch.status !== undefined
          ? { status: patch.status, ...timestampsForStatus(patch.status) }
          : {}),
      },
      tx,
    );
    if (!row) throw AppError.notFound('Ticket not found');

    // Waiting on the customer stops the clock; resolving satisfies it. A
    // priority change deliberately does *not* move a live deadline — the target
    // owns its own minutes, copied from the policy when it was created.
    if (patch.status !== undefined) {
      await slaService.onStatusChanged(
        { id: row.id, productId: row.productId, priority: row.priority },
        before.status,
        row.status,
        tx,
      );
    }

    await auditService.record(
      {
        action: patch.status ? 'ticket.status_changed' : 'ticket.updated',
        entityType: 'ticket',
        entityId: id,
        before: {
          status: before.status,
          priority: before.priority,
          categoryId: before.categoryId,
          subject: before.subject,
        },
        after: {
          status: row.status,
          priority: row.priority,
          categoryId: row.categoryId,
          subject: row.subject,
        },
      },
      actor,
      tx,
    );

    // The most specific name wins rather than being emitted alongside a generic
    // one: a receiver interested only in resolutions subscribes to
    // `ticket.resolved`, and one interested in every move subscribes to all
    // three names. Sending both would deliver every resolution twice.
    afterCommit(async () => {
      await eventService.publish({
        type:
          patch.status === undefined
            ? DOMAIN_EVENT.ticketUpdated
            : becameResolved(before.status, row.status)
              ? DOMAIN_EVENT.ticketResolved
              : DOMAIN_EVENT.ticketStatusChanged,
        ticket: row,
        ...(patch.status === undefined ? {} : { data: { from: before.status, to: row.status } }),
      });
    });

    // Resolution is what earns the right to ask the customer how it went.
    // Delayed, and re-checked when the job runs: the delay is exactly the
    // window in which a customer replies "that did not work" and reopens it.
    if (becameResolved(before.status, row.status)) {
      afterCommit(async () => {
        await enqueue(
          JOB.surveyDispatch,
          { ticketId: id },
          {
            startAfterSeconds: env.CSAT_DELAY_MINUTES * 60,
            // One pending survey per ticket, however many times an agent
            // toggles resolved and back.
            singletonKey: `${JOB.surveyDispatch}:${id}`,
          },
        );
      });
    }
  });

  return get(id, actor);
}

/**
 * Whether this status change is the one that finished the ticket.
 *
 * `resolved → closed` is not: the survey is already on its way, and asking twice
 * about one query is how a response rate reaches zero.
 */
function becameResolved(from: TicketStatus, to: TicketStatus): boolean {
  const finished = (status: TicketStatus): boolean => status === 'resolved' || status === 'closed';
  return finished(to) && !finished(from);
}

/**
 * Assigns or unassigns. Taking an unowned ticket needs only
 * `ticket:assign_self`; handing one to somebody else needs `ticket:assign`,
 * which the route enforces.
 */
export async function assign(
  id: string,
  toUserId: string | null,
  reason: string | undefined,
  actor: Actor,
): Promise<TicketSummary> {
  const before = await requireAccessible(id, actor);

  if (toUserId) {
    const assignee = await userService.requireById(toUserId);
    if (assignee.status !== 'active') {
      throw AppError.validation('That agent is not active', {
        details: [{ field: 'assignedToUserId', issue: `status is ${assignee.status}` }],
      });
    }
    // Assigning work to someone who cannot open it would strand the ticket.
    await assertAssigneeHasProductAccess(assignee.id, before.productId);
  }

  if (before.assignedToUserId === toUserId) return get(id, actor);

  await withTransaction(async ({ tx, afterCommit }) => {
    const row = await repository.update(
      id,
      {
        assignedToUserId: toUserId,
        // Picking up a new ticket moves it out of the unread queue.
        ...(toUserId && before.status === 'new' ? { status: 'open' } : {}),
      },
      tx,
    );
    if (!row) throw AppError.notFound('Ticket not found');

    await repository.recordAssignment(
      {
        ticketId: id,
        fromUserId: before.assignedToUserId,
        toUserId,
        assignedByUserId: isUserActor(actor) ? actor.id : null,
        reason: reason ?? null,
      },
      tx,
    );

    await auditService.record(
      {
        action: toUserId ? 'ticket.assigned' : 'ticket.unassigned',
        entityType: 'ticket',
        entityId: id,
        before: { assignedToUserId: before.assignedToUserId },
        after: { assignedToUserId: toUserId },
      },
      actor,
      tx,
    );

    afterCommit(async () => {
      await eventService.publish({
        type: DOMAIN_EVENT.ticketAssigned,
        ticket: row,
        data: { from: before.assignedToUserId, to: toUserId, reason: reason ?? null },
      });

      if (toUserId && toUserId !== (isUserActor(actor) ? actor.id : null)) {
        await notificationService.notifyAssignment(toUserId, row);
      }
    });
  });

  return get(id, actor);
}

async function assertAssigneeHasProductAccess(userId: string, productId: string): Promise<void> {
  if (!(await productService.userHasProductAccess(userId, productId))) {
    throw AppError.validation('That agent does not have access to this product', {
      details: [{ field: 'assignedToUserId', issue: 'grant them product access first' }],
    });
  }
}

/** Reopens a resolved or closed ticket, counting it for reporting. */
export async function reopen(
  id: string,
  reason: string | undefined,
  actor: Actor,
): Promise<TicketSummary> {
  const before = await requireAccessible(id, actor);

  if (!['resolved', 'closed'].includes(before.status)) {
    throw AppError.validation('Only a resolved or closed ticket can be reopened', {
      details: [{ field: 'status', issue: `current status is ${before.status}` }],
    });
  }

  await withTransaction(async ({ tx, afterCommit }) => {
    const row = await repository.update(
      id,
      {
        status: 'open',
        resolvedAt: null,
        closedAt: null,
        reopenedCount: before.reopenedCount + 1,
      },
      tx,
    );
    if (!row) throw AppError.notFound('Ticket not found');

    afterCommit(async () => {
      await eventService.publish({
        type: DOMAIN_EVENT.ticketReopened,
        ticket: row,
        data: { from: before.status, reason: reason ?? null },
      });
    });

    // A reopened ticket owes a fresh resolution, measured from now. The first
    // response already happened, so that clock stays satisfied.
    await slaService.onStatusChanged(
      { id: before.id, productId: before.productId, priority: before.priority },
      before.status,
      'open',
      tx,
    );

    await auditService.record(
      {
        action: 'ticket.reopened',
        entityType: 'ticket',
        entityId: id,
        before: { status: before.status },
        after: { status: 'open', reason: reason ?? null },
      },
      actor,
      tx,
    );
  });

  return get(id, actor);
}

/**
 * Called by the message module when a customer replies. Reopening happens here
 * so the rule lives with the rest of the lifecycle.
 */
export async function registerCustomerReply(
  ticket: TicketRow,
  exec: Executor,
): Promise<TicketStatus> {
  const reopening = ticket.status === 'resolved' || ticket.status === 'closed';

  await repository.update(
    ticket.id,
    {
      lastCustomerReplyAt: new Date(),
      // A reply to a resolved ticket means it was not resolved.
      ...(reopening
        ? {
            status: 'open',
            resolvedAt: null,
            closedAt: null,
            reopenedCount: ticket.reopenedCount + 1,
          }
        : ticket.status === 'pending'
          ? { status: 'open' }
          : {}),
    },
    exec,
  );

  // The customer answering is what restarts a clock stopped on `pending`, and
  // what puts a resolution obligation back on a ticket thought finished.
  if (reopening || ticket.status === 'pending') {
    await slaService.onStatusChanged(
      { id: ticket.id, productId: ticket.productId, priority: ticket.priority },
      ticket.status,
      'open',
      exec,
    );
  }

  return reopening || ticket.status === 'pending' ? 'open' : ticket.status;
}

/** Called by the message module on the first public agent reply. */
export async function registerAgentReply(ticket: TicketRow, exec: Executor): Promise<boolean> {
  const isFirst = ticket.firstResponseAt === null;
  const now = new Date();

  await repository.update(
    ticket.id,
    {
      lastAgentReplyAt: now,
      ...(isFirst ? { firstResponseAt: now } : {}),
      // Replying to a brand-new ticket puts it in play.
      ...(ticket.status === 'new' ? { status: 'open' } : {}),
    },
    exec,
  );

  // Stops the first-response clock, in the same transaction as the reply that
  // stopped it. Idempotent, so only the first reply counts.
  if (isFirst) await slaService.markFirstResponse(ticket.id, now, exec);

  return isFirst;
}

export async function addTag(id: string, name: string, actor: Actor): Promise<TicketSummary> {
  await requireAccessible(id, actor);

  await withTransaction(async ({ tx }) => {
    const tag = await tagService.findOrCreate(name, actor, tx);
    await tagService.attach(id, tag.id, tx);
    await auditService.record(
      { action: 'ticket.tagged', entityType: 'ticket', entityId: id, after: { tag: tag.name } },
      actor,
      tx,
    );
  });

  return get(id, actor);
}

export async function removeTag(id: string, tagId: string, actor: Actor): Promise<TicketSummary> {
  await requireAccessible(id, actor);

  await withTransaction(async ({ tx }) => {
    const removed = await tagService.detach(id, tagId, tx);
    if (!removed) throw AppError.notFound('That tag is not on this ticket');

    await auditService.record(
      { action: 'ticket.untagged', entityType: 'ticket', entityId: id, before: { tagId } },
      actor,
      tx,
    );
  });

  return get(id, actor);
}

export async function watch(id: string, actor: Actor): Promise<void> {
  if (!isUserActor(actor)) throw AppError.forbidden('Only a signed-in user can watch a ticket');
  await requireAccessible(id, actor);
  await repository.addWatcher(id, actor.id);
}

export async function unwatch(id: string, actor: Actor): Promise<void> {
  if (!isUserActor(actor)) throw AppError.forbidden('Only a signed-in user can watch a ticket');
  await requireAccessible(id, actor);
  await repository.removeWatcher(id, actor.id);
}

export function assignmentHistory(id: string) {
  return repository.assignmentHistory(id);
}

export function watcherIds(id: string, exec?: Executor): Promise<string[]> {
  return repository.watcherIds(id, exec);
}

export function findByReference(
  reference: string,
  exec?: Executor,
): Promise<TicketRow | undefined> {
  return repository.findByReference(reference, exec);
}

export function findRawById(id: string, exec?: Executor): Promise<TicketRow | undefined> {
  return repository.findRawById(id, exec);
}

// -- retention ---------------------------------------------------------------

/**
 * Tickets whose content is past its retention period.
 *
 * Exposed for the retention sweep rather than for any request path, which is why
 * it takes no actor: it runs as a scheduled system job over every product at
 * once, and scoping it to a caller would make compliance a function of who
 * happened to trigger it.
 */
export function listPastRetention(before: Date, limit: number) {
  return repository.listPastRetention(before, limit);
}

export function markAnonymised(ids: readonly string[], at: Date): Promise<number> {
  return repository.markAnonymised(ids, at);
}
