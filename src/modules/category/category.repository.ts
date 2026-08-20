import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { categories, type CategoryRow } from './category.model.js';

export function listForProduct(
  productId: string,
  activeOnly: boolean,
  exec: Executor = db,
): Promise<CategoryRow[]> {
  const conditions = [
    eq(categories.productId, productId),
    activeOnly ? eq(categories.isActive, true) : undefined,
  ].filter((condition) => condition !== undefined);

  return exec
    .select()
    .from(categories)
    .where(and(...conditions))
    .orderBy(asc(categories.sortOrder), asc(categories.name));
}

export async function findById(id: string, exec: Executor = db): Promise<CategoryRow | undefined> {
  const [row] = await exec.select().from(categories).where(eq(categories.id, id)).limit(1);
  return row;
}

export async function insert(
  values: typeof categories.$inferInsert,
  exec: Executor = db,
): Promise<CategoryRow> {
  const [row] = await exec.insert(categories).values(values).returning();
  if (!row) throw new Error('category insert returned no row');
  return row;
}

export async function update(
  id: string,
  patch: Partial<CategoryRow>,
  exec: Executor = db,
): Promise<CategoryRow | undefined> {
  const [row] = await exec.update(categories).set(patch).where(eq(categories.id, id)).returning();
  return row;
}

/** Categories are never hard-deleted while tickets reference them. */
export async function countTickets(id: string, exec: Executor = db): Promise<number> {
  const result = await exec.execute(
    sql`select count(*)::int as count from tickets where category_id = ${id}`,
  );
  const rows = result as unknown as { rows?: { count: number }[] };
  return rows.rows?.[0]?.count ?? 0;
}

export async function remove(id: string, exec: Executor = db): Promise<void> {
  await exec.delete(categories).where(eq(categories.id, id));
}
