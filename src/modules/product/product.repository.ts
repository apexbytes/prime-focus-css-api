import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { users } from '../user/user.model.js';
import { products, userProducts, type NewProduct, type ProductRow } from './product.model.js';
import type { ProductAgent } from './product.types.js';

export function list(activeOnly: boolean, exec: Executor = db): Promise<ProductRow[]> {
  const query = exec.select().from(products);
  return activeOnly
    ? query.where(eq(products.isActive, true)).orderBy(asc(products.name))
    : query.orderBy(asc(products.name));
}

export async function findById(id: string, exec: Executor = db): Promise<ProductRow | undefined> {
  const [row] = await exec.select().from(products).where(eq(products.id, id)).limit(1);
  return row;
}

export async function findByCode(
  code: string,
  exec: Executor = db,
): Promise<ProductRow | undefined> {
  const [row] = await exec.select().from(products).where(eq(products.code, code)).limit(1);
  return row;
}

/** Routes an inbound email to a product by the address it was sent to. */
export async function findBySupportEmail(
  address: string,
  exec: Executor = db,
): Promise<ProductRow | undefined> {
  const [row] = await exec
    .select()
    .from(products)
    .where(eq(sql`lower(${products.supportEmail})`, address.toLowerCase()))
    .limit(1);

  return row;
}

export async function insert(values: NewProduct, exec: Executor = db): Promise<ProductRow> {
  const [row] = await exec.insert(products).values(values).returning();
  if (!row) throw new Error('product insert returned no row');
  return row;
}

export async function update(
  id: string,
  patch: Partial<ProductRow>,
  exec: Executor = db,
): Promise<ProductRow | undefined> {
  const [row] = await exec.update(products).set(patch).where(eq(products.id, id)).returning();
  return row;
}

export async function grantedProductIds(userId: string, exec: Executor = db): Promise<string[]> {
  const rows = await exec
    .select({ productId: userProducts.productId })
    .from(userProducts)
    .where(eq(userProducts.userId, userId));

  return rows.map((row) => row.productId);
}

export function agents(productId: string, exec: Executor = db): Promise<ProductAgent[]> {
  return exec
    .select({
      userId: users.id,
      fullName: users.fullName,
      email: users.email,
      grantedAt: userProducts.createdAt,
    })
    .from(userProducts)
    .innerJoin(users, eq(users.id, userProducts.userId))
    .where(eq(userProducts.productId, productId))
    .orderBy(asc(users.fullName));
}

export async function grant(
  productId: string,
  userId: string,
  grantedByUserId: string | null,
  exec: Executor = db,
): Promise<void> {
  await exec
    .insert(userProducts)
    .values({ productId, userId, grantedByUserId })
    .onConflictDoNothing();
}

export async function revoke(
  productId: string,
  userId: string,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec
    .delete(userProducts)
    .where(and(eq(userProducts.productId, productId), eq(userProducts.userId, userId)))
    .returning({ userId: userProducts.userId });

  return rows.length > 0;
}
