import { and, asc, eq, gt, ilike, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { products } from '../product/product.model.js';
import {
  customerProductAccounts,
  customers,
  type CustomerProductAccountRow,
  type CustomerRow,
  type NewCustomer,
} from './customer.model.js';
import type { ListCustomersFilter } from './customer.types.js';

export async function findById(id: string, exec: Executor = db): Promise<CustomerRow | undefined> {
  const [row] = await exec
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), isNull(customers.deletedAt)))
    .limit(1);

  return row;
}

export async function findByEmail(
  email: string,
  exec: Executor = db,
): Promise<CustomerRow | undefined> {
  const [row] = await exec
    .select()
    .from(customers)
    .where(and(eq(customers.email, email), isNull(customers.deletedAt)))
    .limit(1);

  return row;
}

export async function insert(values: NewCustomer, exec: Executor = db): Promise<CustomerRow> {
  const [row] = await exec.insert(customers).values(values).returning();
  if (!row) throw new Error('customer insert returned no row');
  return row;
}

export async function update(
  id: string,
  patch: Partial<CustomerRow>,
  exec: Executor = db,
): Promise<CustomerRow | undefined> {
  const [row] = await exec.update(customers).set(patch).where(eq(customers.id, id)).returning();
  return row;
}

export function list(filter: ListCustomersFilter, exec: Executor = db): Promise<CustomerRow[]> {
  const conditions = [
    isNull(customers.deletedAt),
    filter.tier ? eq(customers.tier, filter.tier) : undefined,
    filter.search
      ? or(
          ilike(customers.fullName, `%${filter.search}%`),
          ilike(customers.email, `%${filter.search}%`),
          ilike(customers.phone, `%${filter.search}%`),
        )
      : undefined,
    filter.cursor ? gt(customers.email, filter.cursor) : undefined,
  ].filter((condition) => condition !== undefined);

  return exec
    .select()
    .from(customers)
    .where(and(...conditions))
    .orderBy(asc(customers.email))
    .limit(filter.limit);
}

export function accounts(customerId: string, exec: Executor = db) {
  return exec
    .select({
      id: customerProductAccounts.id,
      customerId: customerProductAccounts.customerId,
      productId: customerProductAccounts.productId,
      externalAccountId: customerProductAccounts.externalAccountId,
      status: customerProductAccounts.status,
      createdAt: customerProductAccounts.createdAt,
      updatedAt: customerProductAccounts.updatedAt,
      productName: products.name,
      productCode: products.code,
    })
    .from(customerProductAccounts)
    .innerJoin(products, eq(products.id, customerProductAccounts.productId))
    .where(eq(customerProductAccounts.customerId, customerId))
    .orderBy(asc(products.name));
}

export async function addAccount(
  values: typeof customerProductAccounts.$inferInsert,
  exec: Executor = db,
): Promise<CustomerProductAccountRow> {
  const [row] = await exec
    .insert(customerProductAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: [
        customerProductAccounts.customerId,
        customerProductAccounts.productId,
        customerProductAccounts.externalAccountId,
      ],
      set: { status: values.status ?? null },
    })
    .returning();

  if (!row) throw new Error('customer account upsert returned no row');
  return row;
}

export async function removeAccount(
  customerId: string,
  accountId: string,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec
    .delete(customerProductAccounts)
    .where(
      and(
        eq(customerProductAccounts.id, accountId),
        eq(customerProductAccounts.customerId, customerId),
      ),
    )
    .returning({ id: customerProductAccounts.id });

  return rows.length > 0;
}

/** Moves every product account from one customer to another during a merge. */
export async function reassignAccounts(
  fromCustomerId: string,
  toCustomerId: string,
  exec: Executor = db,
): Promise<void> {
  await exec.execute(sql`
    insert into customer_product_accounts (customer_id, product_id, external_account_id, status)
    select ${toCustomerId}, product_id, external_account_id, status
    from customer_product_accounts
    where customer_id = ${fromCustomerId}
    on conflict (customer_id, product_id, external_account_id) do nothing
  `);

  await exec
    .delete(customerProductAccounts)
    .where(eq(customerProductAccounts.customerId, fromCustomerId));
}

/**
 * Moves a duplicate's tickets to the survivor. Raw SQL and a count, because the
 * ticket module owns that table but a merge must be atomic with the rest of this
 * transaction — a cross-module service call could not participate in it.
 */
export async function reassignTickets(
  fromCustomerId: string,
  toCustomerId: string,
  exec: Executor = db,
): Promise<number> {
  const result = await exec.execute(sql`
    update tickets set customer_id = ${toCustomerId}, updated_at = now()
    where customer_id = ${fromCustomerId}
  `);

  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

// -- retention ---------------------------------------------------------------

/**
 * Customers with no activity since the cutoff.
 *
 * `not exists` rather than a join on the newest ticket: a customer with one
 * recent ticket and fifty old ones must not be anonymised, and the correlated
 * subquery says exactly that. Already-anonymised rows carry `deleted_at`, which
 * is what keeps the batch moving forward.
 */
export function listDormantBefore(
  before: Date,
  limit: number,
  exec: Executor = db,
): Promise<CustomerRow[]> {
  return exec
    .select()
    .from(customers)
    .where(
      and(
        isNull(customers.deletedAt),
        sql`${customers.createdAt} < ${before}`,
        sql`not exists (
          select 1 from tickets t
          where t.customer_id = ${customers.id}
            and (t.resolved_at is null or t.resolved_at >= ${before})
        )`,
      ),
    )
    .orderBy(asc(customers.createdAt))
    .limit(limit);
}

/**
 * Strips a customer's personal data, keeping the row.
 *
 * In place rather than deleted, because every ticket they ever raised points at
 * it: deleting the row would either cascade away five years of volume figures or
 * fail on the foreign key. The email is rewritten into the reserved `.invalid`
 * domain so it stays unique, stays obviously synthetic, and can never be
 * delivered to.
 */
export async function anonymise(id: string, exec: Executor = db): Promise<void> {
  await exec
    .update(customers)
    .set({
      email: `redacted+${id}@retention.invalid`,
      fullName: 'Redacted customer',
      phone: null,
      notes: null,
      externalRefs: null,
      deletedAt: new Date(),
    })
    .where(eq(customers.id, id));
}
