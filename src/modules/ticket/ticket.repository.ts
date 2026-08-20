import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { categories } from '../category/category.model.js';
import { customers } from '../customer/customer.model.js';
import { products } from '../product/product.model.js';
import { users } from '../user/user.model.js';
import {
  ticketAssignments,
  ticketWatchers,
  tickets,
  type NewTicket,
  type TicketRow,
} from './ticket.model.js';
import type { ListTicketsFilter } from './ticket.types.js';

/** Joined projection used by both list and detail reads. */
const summaryColumns = {
  id: tickets.id,
  reference: tickets.reference,
  subject: tickets.subject,
  status: tickets.status,
  priority: tickets.priority,
  channel: tickets.channel,
  productId: tickets.productId,
  productName: products.name,
  customerId: tickets.customerId,
  customerName: customers.fullName,
  customerEmail: customers.email,
  categoryId: tickets.categoryId,
  categoryName: categories.name,
  assignedToUserId: tickets.assignedToUserId,
  assignedToName: users.fullName,
  teamId: tickets.teamId,
  firstResponseAt: tickets.firstResponseAt,
  resolvedAt: tickets.resolvedAt,
  lastCustomerReplyAt: tickets.lastCustomerReplyAt,
  createdAt: tickets.createdAt,
  updatedAt: tickets.updatedAt,
};

function baseQuery(exec: Executor) {
  return exec
    .select(summaryColumns)
    .from(tickets)
    .innerJoin(products, eq(products.id, tickets.productId))
    .innerJoin(customers, eq(customers.id, tickets.customerId))
    .leftJoin(categories, eq(categories.id, tickets.categoryId))
    .leftJoin(users, eq(users.id, tickets.assignedToUserId));
}

/**
 * `productIds` is the caller's access scope: null means unrestricted, an empty
 * array means the caller has no product grants and must see nothing. Passing it
 * explicitly on every read is deliberate — an accidentally omitted scope would
 * leak another product's tickets.
 */
export function list(filter: ListTicketsFilter, productIds: string[] | null, exec: Executor = db) {
  const conditions = [
    isNull(tickets.deletedAt),
    productIds === null ? undefined : scopeCondition(productIds),
    filter.status ? inArray(tickets.status, filter.status) : undefined,
    filter.priority ? inArray(tickets.priority, filter.priority) : undefined,
    filter.productId ? eq(tickets.productId, filter.productId) : undefined,
    filter.categoryId ? eq(tickets.categoryId, filter.categoryId) : undefined,
    filter.assignedToUserId ? eq(tickets.assignedToUserId, filter.assignedToUserId) : undefined,
    filter.unassigned ? isNull(tickets.assignedToUserId) : undefined,
    filter.customerId ? eq(tickets.customerId, filter.customerId) : undefined,
    filter.teamId ? eq(tickets.teamId, filter.teamId) : undefined,
    filter.search ? searchCondition(filter.search) : undefined,
    // Keyset pagination on createdAt, matching the index's descending order.
    filter.cursor ? lt(tickets.createdAt, new Date(filter.cursor)) : undefined,
  ].filter((condition) => condition !== undefined);

  return baseQuery(exec)
    .where(and(...conditions))
    .orderBy(desc(tickets.createdAt))
    .limit(filter.limit);
}

function scopeCondition(productIds: string[]) {
  // An empty grant list must match nothing, not everything.
  return productIds.length === 0 ? sql`false` : inArray(tickets.productId, productIds);
}

function searchCondition(term: string) {
  const like = `%${term}%`;
  return or(
    sql`${tickets.subject} ilike ${like}`,
    sql`${tickets.reference} ilike ${like}`,
    sql`${customers.email} ilike ${like}`,
    sql`${customers.fullName} ilike ${like}`,
  );
}

export async function findById(id: string, exec: Executor = db) {
  const [row] = await baseQuery(exec)
    .where(and(eq(tickets.id, id), isNull(tickets.deletedAt)))
    .limit(1);

  return row;
}

/** Raw row, for services that need to compare state before writing. */
export async function findRawById(id: string, exec: Executor = db): Promise<TicketRow | undefined> {
  const [row] = await exec
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, id), isNull(tickets.deletedAt)))
    .limit(1);

  return row;
}

export async function findByReference(
  reference: string,
  exec: Executor = db,
): Promise<TicketRow | undefined> {
  const [row] = await exec
    .select()
    .from(tickets)
    .where(and(eq(tickets.reference, reference), isNull(tickets.deletedAt)))
    .limit(1);

  return row;
}

/**
 * Next human-facing reference. A sequence rather than a count, so two concurrent
 * creates cannot produce the same number.
 */
export async function nextReference(prefix: string, exec: Executor = db): Promise<string> {
  const result = await exec.execute(sql`select nextval('ticket_reference_seq') as value`);
  const rows = result as unknown as { rows?: { value: string | number }[] };
  const value = Number(rows.rows?.[0]?.value ?? 0);

  return `${prefix}-${new Date().getUTCFullYear()}-${String(value).padStart(6, '0')}`;
}

export async function insert(values: NewTicket, exec: Executor = db): Promise<TicketRow> {
  const [row] = await exec.insert(tickets).values(values).returning();
  if (!row) throw new Error('ticket insert returned no row');
  return row;
}

export async function update(
  id: string,
  patch: Partial<TicketRow>,
  exec: Executor = db,
): Promise<TicketRow | undefined> {
  const [row] = await exec.update(tickets).set(patch).where(eq(tickets.id, id)).returning();
  return row;
}

export async function recordAssignment(
  values: typeof ticketAssignments.$inferInsert,
  exec: Executor = db,
): Promise<void> {
  await exec.insert(ticketAssignments).values(values);
}

export function assignmentHistory(ticketId: string, exec: Executor = db) {
  return exec
    .select()
    .from(ticketAssignments)
    .where(eq(ticketAssignments.ticketId, ticketId))
    .orderBy(desc(ticketAssignments.createdAt));
}

export async function addWatcher(
  ticketId: string,
  userId: string,
  exec: Executor = db,
): Promise<void> {
  await exec.insert(ticketWatchers).values({ ticketId, userId }).onConflictDoNothing();
}

export async function removeWatcher(
  ticketId: string,
  userId: string,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec
    .delete(ticketWatchers)
    .where(and(eq(ticketWatchers.ticketId, ticketId), eq(ticketWatchers.userId, userId)))
    .returning({ userId: ticketWatchers.userId });

  return rows.length > 0;
}

export async function watcherIds(ticketId: string, exec: Executor = db): Promise<string[]> {
  const rows = await exec
    .select({ userId: ticketWatchers.userId })
    .from(ticketWatchers)
    .where(eq(ticketWatchers.ticketId, ticketId));

  return rows.map((row) => row.userId);
}
