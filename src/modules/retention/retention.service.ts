import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { env } from '../../config/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as attachmentService from '../attachment/attachment.service.js';
import * as auditService from '../audit/audit.service.js';
import * as chatService from '../chat/chat.service.js';
import * as conversationService from '../conversation/conversation.service.js';
import * as customerService from '../customer/customer.service.js';
import * as messageService from '../message/message.service.js';
import * as realtimeService from '../realtime/realtime.service.js';
import * as ssoService from '../sso/sso.service.js';
import * as ticketService from '../ticket/ticket.service.js';
import * as webhookService from '../webhook/webhook.service.js';
import { cutoffsFor, isCoherent, type RetentionCutoffs } from './retention.policy.js';

const log = createModuleLogger('retention');

const RETENTION_ACTOR = { kind: 'system', name: 'retention.sweep' } as const;

export interface RetentionPolicyView {
  auditLogYears: number;
  ticketYears: number;
  cutoffs: { auditLogsBefore: Date; ticketContentBefore: Date };
  enabled: boolean;
  cron: string;
  batchSize: number;
  /** What a sweep would touch right now, without touching it. */
  pending: { auditLogs: number; tickets: number };
}

export interface SweepResult {
  dryRun: boolean;
  cutoffs: { auditLogsBefore: Date; ticketContentBefore: Date };
  auditLogsDeleted: number;
  ticketsAnonymised: number;
  messagesAnonymised: number;
  attachmentsDeleted: number;
  customersAnonymised: number;
  /**
   * Housekeeping rather than policy. A webhook delivery row is not personal
   * data the Act has an opinion about — it is a log of what a partner system
   * was told, reconstructible from the tickets and the audit trail — so it has
   * its own period in days, swept here because this is the module that already
   * runs weekly with permission to delete things.
   */
  webhookDeliveriesDeleted: number;
  /** Abandoned ticket locks, cleared in the same pass for the same reason. */
  ticketLocksReleased: number;
  /** Expired federated sign-in requests, likewise: spent, and not personal data. */
  ssoLoginRequestsPurged: number;
  /**
   * Inbound and outbound channel envelopes past their period.
   *
   * The same class again: what a customer actually said on WhatsApp is on the
   * ticket, which the ticket period above governs. These rows are the provider's
   * envelope around it — kept long enough to debug a filing that went wrong, and
   * no longer. Only settled inbound rows go; one still `received` or `failed` is
   * unfiled work, and deleting it would lose a customer's message rather than a
   * log line.
   */
  channelLogsDeleted: number;
  /** Dead live-chat session tokens. Nothing but a credential nobody can use. */
  chatSessionsPurged: number;
  /** True when the batch limit was reached, so there is more to do next run. */
  moreRemaining: boolean;
}

function policy() {
  return { auditLogYears: env.RETENTION_AUDIT_LOG_YEARS, ticketYears: env.RETENTION_TICKET_YEARS };
}

/**
 * What the policy currently is and what it would touch.
 *
 * Read-only, and worth having as its own endpoint: the sweep is irreversible, so
 * being able to ask "what would this destroy" without destroying it is the
 * difference between a policy somebody has reviewed and a policy somebody hopes
 * is right.
 */
export async function describePolicy(): Promise<RetentionPolicyView> {
  const cutoffs = cutoffsFor(policy());

  return {
    ...policy(),
    cutoffs,
    enabled: env.RETENTION_SWEEP_ENABLED,
    cron: env.RETENTION_SWEEP_CRON,
    batchSize: env.RETENTION_SWEEP_BATCH_SIZE,
    pending: {
      auditLogs: await auditService.countOlderThan(cutoffs.auditLogsBefore),
      tickets: (
        await ticketService.listPastRetention(
          cutoffs.ticketContentBefore,
          env.RETENTION_SWEEP_BATCH_SIZE,
        )
      ).length,
    },
  };
}

/**
 * Enforces the retention policy: one batch of it.
 *
 * Zimbabwe's Cyber and Data Protection Act (2021) is what this implements —
 * seven years of audit trail, five years of ticket content, then the customer's
 * personal data anonymised in place rather than deleted, so aggregate reporting
 * survives the person leaving the dataset.
 *
 * Three properties this deliberately has:
 *
 *  - **Batched.** `RETENTION_SWEEP_BATCH_SIZE` rows at a time, and `moreRemaining`
 *    says whether to expect more next week. The first run on an old database is
 *    otherwise one enormous locking statement.
 *  - **Ordered content-first, audit-last.** Attachments and message bodies go
 *    before the audit rows describing them are considered, so a sweep
 *    interrupted halfway has destroyed content whose destruction is still on the
 *    record — never the other way round.
 *  - **Dry-runnable**, and the manual endpoint dry-runs by default. An operator
 *    clicking a button labelled "sweep" should not be one click from deleting
 *    five-year-old evidence.
 */
export async function sweep(
  options: { dryRun?: boolean; actor?: Actor } = {},
): Promise<SweepResult> {
  const current = policy();

  if (!isCoherent(current)) {
    // Refused rather than clamped: a policy where the audit trail dies before
    // the data it describes is a configuration mistake somebody has to see.
    throw AppError.validation('The retention policy is incoherent', {
      details: [
        {
          field: 'RETENTION_AUDIT_LOG_YEARS',
          issue: `must be at least RETENTION_TICKET_YEARS (${current.ticketYears})`,
        },
      ],
    });
  }

  const dryRun = options.dryRun ?? false;
  const cutoffs = cutoffsFor(current);
  const limit = env.RETENTION_SWEEP_BATCH_SIZE;

  const stale = await ticketService.listPastRetention(cutoffs.ticketContentBefore, limit);
  const ticketIds = stale.map((ticket) => ticket.id);

  if (dryRun) {
    return {
      dryRun: true,
      cutoffs,
      auditLogsDeleted: await auditService.countOlderThan(cutoffs.auditLogsBefore),
      ticketsAnonymised: ticketIds.length,
      messagesAnonymised: 0,
      attachmentsDeleted: 0,
      customersAnonymised: 0,
      webhookDeliveriesDeleted: 0,
      ticketLocksReleased: 0,
      ssoLoginRequestsPurged: 0,
      channelLogsDeleted: 0,
      chatSessionsPurged: 0,
      moreRemaining: ticketIds.length === limit,
    };
  }

  const result = await enforce(cutoffs, ticketIds, limit);

  // The sweep's own record, written after the fact and into the trail whose
  // retention period is the longest in the system.
  await auditService.recordSafely(
    {
      action: 'retention.swept',
      entityType: 'retention',
      after: {
        cutoffs,
        webhookDeliveryDays: env.WEBHOOK_DELIVERY_RETENTION_DAYS,
        auditLogsDeleted: result.auditLogsDeleted,
        ticketsAnonymised: result.ticketsAnonymised,
        messagesAnonymised: result.messagesAnonymised,
        attachmentsDeleted: result.attachmentsDeleted,
        customersAnonymised: result.customersAnonymised,
      },
    },
    options.actor ?? RETENTION_ACTOR,
  );

  if (
    result.auditLogsDeleted +
      result.ticketsAnonymised +
      result.attachmentsDeleted +
      result.customersAnonymised >
    0
  ) {
    log.warn('retention sweep destroyed data', result);
  }

  return result;
}

/**
 * The destructive half, in the order it has to happen.
 *
 * Attachments before message bodies before the ticket marker: the marker is what
 * stops the next run reprocessing this ticket, so it is set last. A crash
 * between steps leaves the ticket unmarked and the next run repeats the work,
 * which is harmless — all three operations are idempotent on already-stripped
 * data.
 */
async function enforce(
  cutoffs: RetentionCutoffs,
  ticketIds: readonly string[],
  limit: number,
): Promise<SweepResult> {
  const attachmentsDeleted = await attachmentService.purgeForTickets(ticketIds);
  const messagesAnonymised = await messageService.anonymiseForTickets(ticketIds);
  const ticketsAnonymised = await ticketService.markAnonymised(ticketIds, new Date());

  // After the tickets, so a customer whose last ticket was just stripped is
  // eligible in this same run rather than waiting a week.
  const customersAnonymised = await customerService.anonymiseDormant(
    cutoffs.ticketContentBefore,
    limit,
  );

  const auditLogsDeleted = await auditService.purgeOlderThan(cutoffs.auditLogsBefore, limit);

  // Housekeeping, after the policy's own work: neither of these is personal
  // data, and neither may fail the sweep that matters.
  const webhookDeliveriesDeleted = await webhookService.purgeDeliveries(
    daysBefore(env.WEBHOOK_DELIVERY_RETENTION_DAYS),
    limit,
  );
  const ticketLocksReleased = await realtimeService.sweepExpiredLocks();
  // A sign-in request expires in minutes, so anything still here is spent. The
  // cutoff is `now`, not a retention period: there is nothing to keep.
  const ssoLoginRequestsPurged = await ssoService.purgeLoginRequests(new Date(), limit);

  // The channel envelopes share the webhook delivery log's period: both are a
  // record of what crossed a provider boundary, and neither is the record of
  // what was said.
  const channelLogsDeleted = await conversationService.purgeChannelLogs(
    daysBefore(env.WEBHOOK_DELIVERY_RETENTION_DAYS),
  );
  // `now`, not a period: a chat token expires in hours, so anything still here
  // is already useless to whoever held it.
  const chatSessionsPurged = await chatService.sweepExpiredSessions(new Date(), limit);

  return {
    dryRun: false,
    cutoffs,
    auditLogsDeleted,
    ticketsAnonymised,
    messagesAnonymised,
    attachmentsDeleted,
    customersAnonymised,
    webhookDeliveriesDeleted,
    ticketLocksReleased,
    ssoLoginRequestsPurged,
    channelLogsDeleted,
    chatSessionsPurged,
    moreRemaining:
      ticketIds.length === limit ||
      auditLogsDeleted === limit ||
      customersAnonymised === limit ||
      webhookDeliveriesDeleted === limit ||
      chatSessionsPurged === limit,
  };
}

const DAY_MS = 86_400_000;

function daysBefore(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}
