import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { generateSecret, hashSecret } from '../../common/utils/crypto.js';
import { env } from '../../config/index.js';
import { withTransaction } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { csatSurveyEmail, sendEmail, webUrl } from '../../lib/resend/index.js';
import * as auditService from '../audit/audit.service.js';
import * as conversationService from '../conversation/conversation.service.js';
import * as eventService from '../event/event.service.js';
import { DOMAIN_EVENT } from '../event/event.types.js';
import * as customerService from '../customer/customer.service.js';
import * as productService from '../product/product.service.js';
import * as ticketService from '../ticket/ticket.service.js';
import * as userService from '../user/user.service.js';
import type { CsatSurveyRow } from './survey.model.js';
import * as repository from './survey.repository.js';
import type { CsatSummary, SurveyPrompt } from './survey.types.js';

const log = createModuleLogger('survey');

const DAY_MS = 86_400_000;

export interface DispatchResult {
  status: 'sent' | 'skipped';
  reason?: string;
  surveyId?: string;
}

/**
 * Sends the survey for a resolved ticket, if it should be sent at all.
 *
 * Every guard below answers "skipped", not "failed". A survey is optional
 * courtesy: none of the reasons not to send one is an error worth retrying, and
 * a job that threw on them would retry three times and then dead-letter for
 * nothing.
 *
 * Called from the `survey.dispatch` job rather than from the resolve itself,
 * after a delay, so a customer who is about to say "that did not work" reopens
 * the ticket instead of rating a resolution that did not hold.
 */
export async function dispatch(ticketId: string): Promise<DispatchResult> {
  if (!env.CSAT_ENABLED) return { status: 'skipped', reason: 'csat is disabled' };

  const ticket = await ticketService.findRawById(ticketId);
  if (!ticket) return { status: 'skipped', reason: 'ticket no longer exists' };

  // Re-checked here, not trusted from the payload: between the resolve and this
  // job the customer may well have replied and reopened it, and asking how a
  // resolution went while the ticket is open again is worse than not asking.
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
    return { status: 'skipped', reason: `ticket is ${ticket.status} again` };
  }

  if (await repository.findByTicket(ticketId)) {
    return { status: 'skipped', reason: 'already surveyed' };
  }

  // A ticket nobody answered has nothing to rate. This catches the case that
  // matters: a duplicate or spam ticket closed without a word to the customer.
  if (!ticket.firstResponseAt) {
    return { status: 'skipped', reason: 'the customer was never replied to' };
  }

  const customer = await customerService.findById(ticket.customerId);
  if (!customer || customer.deletedAt) {
    return { status: 'skipped', reason: 'customer record is gone' };
  }

  // How this customer can be reached, decided before a row is written: a survey
  // that could never be delivered would sit with `sent_at` null forever and drag
  // down a response rate it was never part of.
  //
  // An address wins when there is one — a link in a mailbox outlives any
  // conversation. Failing that, the channel the ticket arrived on is asked
  // whether it can still reach anybody, which for WhatsApp it can and for a
  // closed browser tab it cannot.
  const route = await resolveRoute(ticket.id, customer.email);
  if (!route) {
    return { status: 'skipped', reason: 'no way to reach this customer' };
  }
  if (route.kind === 'unreachable') {
    return { status: 'skipped', reason: route.reason };
  }

  const recent = await repository.lastForCustomer(customer.id);
  if (recent && withinCooldown(recent.createdAt)) {
    // Survey fatigue is the fastest way to a response rate of zero. A customer
    // who raised five tickets this week is asked once.
    return { status: 'skipped', reason: 'customer surveyed recently' };
  }

  const product = await productService.requireById(ticket.productId);
  const agent = ticket.assignedToUserId
    ? await userService.findById(ticket.assignedToUserId)
    : undefined;

  const token = generateSecret(32);
  const now = new Date();

  const survey = await withTransaction(async ({ tx }) => {
    const row = await repository.insert(
      {
        ticketId: ticket.id,
        customerId: customer.id,
        productId: ticket.productId,
        ratedUserId: ticket.assignedToUserId,
        ratedTeamId: ticket.teamId,
        tokenHash: hashSecret(token),
        expiresAt: new Date(now.getTime() + env.CSAT_TOKEN_TTL_DAYS * DAY_MS),
      },
      tx,
    );

    await auditService.record(
      {
        action: 'csat.dispatched',
        entityType: 'ticket',
        entityId: ticket.id,
        after: { surveyId: row.id, ratedUserId: row.ratedUserId },
      },
      { kind: 'system', name: 'survey.dispatch' },
      tx,
    );

    return row;
  });

  const result =
    route.kind === 'email'
      ? await sendByEmail({
          to: route.email,
          token,
          customerName: customer.fullName,
          reference: ticket.reference,
          subject: ticket.subject,
          productName: product.name,
          agentName: agent?.fullName ?? null,
        })
      : await conversationService.sendSurveyInvite({
          ticketId: ticket.id,
          // One link rather than one per score. Five URLs in a WhatsApp message
          // reads as spam, and link previews are off on this channel anyway, so
          // the per-score shortcut the email uses buys nothing here.
          body: `Your ${product.name} query ${ticket.reference} is resolved. How did we do? Tap to rate from 1 to 5:\n\n${webUrl('/survey', { token })}`,
        });

  if (!result.delivered) {
    // The row stays with `sent_at` null: the token is still valid, and a resend
    // is a matter of re-sending the same link rather than issuing a new survey.
    // Unsent rows are what keep the response rate honest — a survey nobody
    // received is not a survey nobody answered.
    log.error('csat survey could not be delivered', {
      surveyId: survey.id,
      ticketId: ticket.id,
      via: route.kind,
      reason: result.reason,
    });
    return {
      status: 'skipped',
      reason: result.reason ?? 'delivery failed',
      surveyId: survey.id,
    };
  }

  await repository.update(survey.id, { sentAt: new Date() });

  log.info('csat survey sent', {
    surveyId: survey.id,
    ticketId: ticket.id,
    reference: ticket.reference,
    via: route.kind,
  });

  return { status: 'sent', surveyId: survey.id };
}

/**
 * Where a survey for this ticket can go.
 *
 * An address beats a conversation whenever there is one, because a link in a
 * mailbox is still there next week and a WhatsApp reply window is not.
 */
type SurveyRoute =
  { kind: 'email'; email: string } | { kind: 'channel' } | { kind: 'unreachable'; reason: string };

async function resolveRoute(ticketId: string, email: string | null): Promise<SurveyRoute | null> {
  if (email) return { kind: 'email', email };

  const { channel, reason } = await conversationService.surveyableChannel(ticketId);
  if (channel) return { kind: 'channel' };

  return { kind: 'unreachable', reason: reason ?? 'no way to reach this customer' };
}

async function sendByEmail(input: {
  to: string;
  token: string;
  customerName: string;
  reference: string;
  subject: string;
  productName: string;
  agentName: string | null;
}): Promise<{ delivered: boolean; reason?: string }> {
  const rendered = csatSurveyEmail({
    fullName: input.customerName,
    reference: input.reference,
    subject: input.subject,
    productName: input.productName,
    agentName: input.agentName,
    // The link lands on the console, which then POSTs the score. A GET that
    // recorded a rating would be cast by the first mail scanner to follow it.
    surveyUrl: (score) => webUrl('/survey', { token: input.token, score: String(score) }),
  });

  const result = await sendEmail({ ...rendered, to: input.to, kind: 'csat_survey' });
  return {
    delivered: result.delivered,
    ...(result.delivered ? {} : { reason: 'delivery failed' }),
  };
}

function withinCooldown(sentAt: Date): boolean {
  if (env.CSAT_CUSTOMER_COOLDOWN_DAYS === 0) return false;
  return Date.now() - sentAt.getTime() < env.CSAT_CUSTOMER_COOLDOWN_DAYS * DAY_MS;
}

// -- the public rating endpoints ---------------------------------------------

/**
 * Resolves a token into the survey it belongs to.
 *
 * Everything is one error — unknown, expired, whatever — because this endpoint
 * is unauthenticated and a distinction here would tell a caller with a guessed
 * token whether it was ever real.
 */
async function requireSurvey(token: string): Promise<CsatSurveyRow> {
  const survey = await repository.findByTokenHash(hashSecret(token));

  if (!survey) throw AppError.notFound('This survey link is not valid');
  if (survey.expiresAt.getTime() < Date.now()) {
    throw AppError.notFound('This survey link has expired');
  }

  return survey;
}

/** What the rating page shows. Carries no ticket detail beyond the subject. */
export async function prompt(token: string): Promise<SurveyPrompt> {
  const survey = await requireSurvey(token);

  const ticket = await ticketService.findRawById(survey.ticketId);
  if (!ticket) throw AppError.notFound('This survey link is not valid');

  const [customer, product] = await Promise.all([
    customerService.findById(survey.customerId),
    productService.requireById(survey.productId),
  ]);

  return {
    reference: ticket.reference,
    subject: ticket.subject,
    productName: product.name,
    customerName: customer?.fullName ?? '',
    score: survey.score,
    comment: survey.comment,
    respondedAt: survey.respondedAt,
    expiresAt: survey.expiresAt,
  };
}

/**
 * Records a rating.
 *
 * Answerable once. A customer who wants to change their mind has to be handled
 * by a person — an endlessly re-scorable survey is a metric anyone holding the
 * link can move, and the link travels by email.
 */
export async function respond(
  token: string,
  input: { score: number; comment?: string | undefined },
): Promise<SurveyPrompt> {
  const survey = await requireSurvey(token);

  if (survey.respondedAt) {
    throw AppError.conflict('This survey has already been answered');
  }

  await withTransaction(async ({ tx, afterCommit }) => {
    const row = await repository.update(
      survey.id,
      {
        score: input.score,
        comment: input.comment ?? null,
        respondedAt: new Date(),
      },
      tx,
    );
    if (!row) throw AppError.notFound('This survey link is not valid');

    // The score, not the comment: a customer's free text about an agent goes to
    // the people who handle the ticket, not to every system subscribed to the
    // product. `GET /csat` returns it to staff who hold `report:view`.
    afterCommit(async () => {
      await eventService.publishForTicket(DOMAIN_EVENT.csatReceived, survey.ticketId, {
        surveyId: survey.id,
        score: input.score,
        ratedUserId: survey.ratedUserId,
      });
    });

    await auditService.record(
      {
        action: 'csat.answered',
        entityType: 'ticket',
        entityId: survey.ticketId,
        after: { surveyId: survey.id, score: input.score },
      },
      // The customer is not an actor in this system; the survey token is the
      // authority, and naming it is more honest than attributing it to a user.
      { kind: 'system', name: 'survey.response' },
      tx,
    );
  });

  log.info('csat survey answered', { surveyId: survey.id, score: input.score });

  return prompt(token);
}

// -- staff reads -------------------------------------------------------------

export async function list(
  filter: {
    productId?: string | undefined;
    ratedUserId?: string | undefined;
    answeredOnly: boolean;
    from?: Date | undefined;
    to?: Date | undefined;
    limit: number;
    cursor?: string | undefined;
  },
  actor: Actor,
): Promise<CsatSurveyRow[]> {
  if (filter.productId) await productService.assertAccess(actor, filter.productId);

  const scope = await productService.scopeFor(actor);

  return repository.list({
    ...filter,
    productIds: scope.kind === 'all' ? null : scope.productIds,
  });
}

/** The survey for one ticket, for the ticket's own panel. */
export async function forTicket(ticketId: string, actor: Actor): Promise<CsatSurveyRow | null> {
  await ticketService.requireAccessible(ticketId, actor);
  return (await repository.findByTicket(ticketId)) ?? null;
}

/** Turns a set of surveys into the CSAT figures. Used by the reports. */
export function summarise(surveys: readonly CsatSurveyRow[]): CsatSummary {
  const answered = surveys.filter((survey) => survey.score !== null);
  const distribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };

  let total = 0;
  for (const survey of answered) {
    const score = survey.score as 1 | 2 | 3 | 4 | 5;
    distribution[String(score) as '1'] += 1;
    total += score;
  }

  const promoters = distribution['4'] + distribution['5'];

  return {
    surveysSent: surveys.length,
    responses: answered.length,
    responseRate: surveys.length === 0 ? 0 : answered.length / surveys.length,
    averageScore: answered.length === 0 ? null : total / answered.length,
    satisfactionRate: answered.length === 0 ? null : promoters / answered.length,
    distribution,
  };
}
