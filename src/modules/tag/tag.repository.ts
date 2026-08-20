import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { tags, ticketTags, type TagRow } from './tag.model.js';

export function list(exec: Executor = db): Promise<TagRow[]> {
  return exec.select().from(tags).orderBy(asc(tags.name));
}

export async function findById(id: string, exec: Executor = db): Promise<TagRow | undefined> {
  const [row] = await exec.select().from(tags).where(eq(tags.id, id)).limit(1);
  return row;
}

export async function findByName(name: string, exec: Executor = db): Promise<TagRow | undefined> {
  const [row] = await exec.select().from(tags).where(eq(tags.name, name)).limit(1);
  return row;
}

export async function insert(
  values: typeof tags.$inferInsert,
  exec: Executor = db,
): Promise<TagRow> {
  const [row] = await exec.insert(tags).values(values).returning();
  if (!row) throw new Error('tag insert returned no row');
  return row;
}

export async function remove(id: string, exec: Executor = db): Promise<void> {
  await exec.delete(tags).where(eq(tags.id, id));
}

// -- ticket associations ------------------------------------------------------

export function forTicket(ticketId: string, exec: Executor = db): Promise<TagRow[]> {
  return exec
    .select({
      id: tags.id,
      name: tags.name,
      colour: tags.colour,
      createdByUserId: tags.createdByUserId,
      createdAt: tags.createdAt,
      updatedAt: tags.updatedAt,
    })
    .from(ticketTags)
    .innerJoin(tags, eq(tags.id, ticketTags.tagId))
    .where(eq(ticketTags.ticketId, ticketId))
    .orderBy(asc(tags.name));
}

/** Tag names for several tickets at once, to avoid an N+1 on list endpoints. */
export async function forTickets(
  ticketIds: string[],
  exec: Executor = db,
): Promise<Map<string, string[]>> {
  if (ticketIds.length === 0) return new Map();

  const rows = await exec
    .select({ ticketId: ticketTags.ticketId, name: tags.name })
    .from(ticketTags)
    .innerJoin(tags, eq(tags.id, ticketTags.tagId))
    .where(inArray(ticketTags.ticketId, ticketIds));

  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const existing = grouped.get(row.ticketId);
    if (existing) existing.push(row.name);
    else grouped.set(row.ticketId, [row.name]);
  }
  return grouped;
}

export async function attach(ticketId: string, tagId: string, exec: Executor = db): Promise<void> {
  await exec.insert(ticketTags).values({ ticketId, tagId }).onConflictDoNothing();
}

export async function detach(
  ticketId: string,
  tagId: string,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec
    .delete(ticketTags)
    .where(and(eq(ticketTags.ticketId, ticketId), eq(ticketTags.tagId, tagId)))
    .returning({ tagId: ticketTags.tagId });

  return rows.length > 0;
}
