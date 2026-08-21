import { and, desc, eq, gte, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { csatSurveys, type CsatSurveyRow, type NewCsatSurvey } from './survey.model.js';

export async function insert(values: NewCsatSurvey, exec: Executor = db): Promise<CsatSurveyRow> {
  const [row] = await exec.insert(csatSurveys).values(values).returning();
  if (!row) throw new Error('csat survey insert returned no row');
  return row;
}

export async function findByTicket(
  ticketId: string,
  exec: Executor = db,
): Promise<CsatSurveyRow | undefined> {
  const [row] = await exec
    .select()
    .from(csatSurveys)
    .where(eq(csatSurveys.ticketId, ticketId))
    .limit(1);

  return row;
}

/**
 * Looks a survey up by the digest of its token.
 *
 * The token itself is never stored, so this is the only way in: an attacker with
 * the database has hashes, and a hash is not a link.
 */
export async function findByTokenHash(
  tokenHash: string,
  exec: Executor = db,
): Promise<CsatSurveyRow | undefined> {
  const [row] = await exec
    .select()
    .from(csatSurveys)
    .where(eq(csatSurveys.tokenHash, tokenHash))
    .limit(1);

  return row;
}

export async function update(
  id: string,
  patch: Partial<CsatSurveyRow>,
  exec: Executor = db,
): Promise<CsatSurveyRow | undefined> {
  const [row] = await exec.update(csatSurveys).set(patch).where(eq(csatSurveys.id, id)).returning();
  return row;
}

/** The most recent survey sent to a customer, for the cooldown check. */
export async function lastForCustomer(
  customerId: string,
  exec: Executor = db,
): Promise<CsatSurveyRow | undefined> {
  const [row] = await exec
    .select()
    .from(csatSurveys)
    .where(eq(csatSurveys.customerId, customerId))
    .orderBy(desc(csatSurveys.createdAt))
    .limit(1);

  return row;
}

export function list(
  filter: {
    productIds: string[] | null;
    productId?: string | undefined;
    ratedUserId?: string | undefined;
    answeredOnly: boolean;
    from?: Date | undefined;
    to?: Date | undefined;
    limit: number;
    cursor?: string | undefined;
  },
  exec: Executor = db,
): Promise<CsatSurveyRow[]> {
  const conditions = [
    scopeCondition(filter.productIds),
    filter.productId ? eq(csatSurveys.productId, filter.productId) : undefined,
    filter.ratedUserId ? eq(csatSurveys.ratedUserId, filter.ratedUserId) : undefined,
    filter.answeredOnly ? isNotNull(csatSurveys.respondedAt) : undefined,
    filter.from ? gte(csatSurveys.createdAt, filter.from) : undefined,
    filter.to ? lte(csatSurveys.createdAt, filter.to) : undefined,
    filter.cursor ? lt(csatSurveys.createdAt, new Date(filter.cursor)) : undefined,
  ].filter((condition) => condition !== undefined);

  return exec
    .select()
    .from(csatSurveys)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(csatSurveys.createdAt))
    .limit(filter.limit);
}

/** An empty grant list must match nothing, not everything. */
function scopeCondition(productIds: string[] | null) {
  if (productIds === null) return undefined;
  if (productIds.length === 0) return sql`false`;

  return inArray(csatSurveys.productId, productIds);
}
