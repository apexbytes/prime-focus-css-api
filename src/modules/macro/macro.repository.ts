import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { macros, type MacroRow } from './macro.model.js';

/** Macros for a product, plus the global ones that apply everywhere. */
export function listForProduct(
  productId: string | undefined,
  exec: Executor = db,
): Promise<MacroRow[]> {
  const scope = productId
    ? or(eq(macros.productId, productId), isNull(macros.productId))
    : isNull(macros.productId);

  return exec
    .select()
    .from(macros)
    .where(and(eq(macros.isActive, true), scope))
    .orderBy(asc(macros.name));
}

export async function findById(id: string, exec: Executor = db): Promise<MacroRow | undefined> {
  const [row] = await exec.select().from(macros).where(eq(macros.id, id)).limit(1);
  return row;
}

export async function insert(
  values: typeof macros.$inferInsert,
  exec: Executor = db,
): Promise<MacroRow> {
  const [row] = await exec.insert(macros).values(values).returning();
  if (!row) throw new Error('macro insert returned no row');
  return row;
}

export async function update(
  id: string,
  patch: Partial<MacroRow>,
  exec: Executor = db,
): Promise<MacroRow | undefined> {
  const [row] = await exec.update(macros).set(patch).where(eq(macros.id, id)).returning();
  return row;
}

export async function remove(id: string, exec: Executor = db): Promise<void> {
  await exec.delete(macros).where(eq(macros.id, id));
}
