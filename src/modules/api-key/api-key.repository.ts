import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { apiKeys, type ApiKeyRow } from './api-key.model.js';

export async function insert(
  values: typeof apiKeys.$inferInsert,
  exec: Executor = db,
): Promise<ApiKeyRow> {
  const [row] = await exec.insert(apiKeys).values(values).returning();
  if (!row) throw new Error('api key insert returned no row');
  return row;
}

/** Single indexed read: the prefix is the non-secret half of the presented key. */
export async function findByPrefix(
  prefix: string,
  exec: Executor = db,
): Promise<ApiKeyRow | undefined> {
  const [row] = await exec.select().from(apiKeys).where(eq(apiKeys.keyPrefix, prefix)).limit(1);
  return row;
}

export function list(exec: Executor = db): Promise<ApiKeyRow[]> {
  return exec.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
}

export async function findById(id: string, exec: Executor = db): Promise<ApiKeyRow | undefined> {
  const [row] = await exec.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  return row;
}

export async function revoke(id: string, exec: Executor = db): Promise<ApiKeyRow | undefined> {
  const [row] = await exec
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning();

  return row;
}

export async function touch(id: string, exec: Executor = db): Promise<void> {
  await exec.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
}
