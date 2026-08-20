import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import {
  notificationPreferences,
  notifications,
  type NotificationPreferencesRow,
  type NotificationRow,
} from './notification.model.js';

export async function insert(
  values: typeof notifications.$inferInsert,
  exec: Executor = db,
): Promise<NotificationRow> {
  const [row] = await exec.insert(notifications).values(values).returning();
  if (!row) throw new Error('notification insert returned no row');
  return row;
}

export function list(
  userId: string,
  filter: { unreadOnly: boolean; limit: number; cursor?: string },
  exec: Executor = db,
): Promise<NotificationRow[]> {
  const conditions = [
    eq(notifications.userId, userId),
    filter.unreadOnly ? isNull(notifications.readAt) : undefined,
    filter.cursor ? lt(notifications.createdAt, new Date(filter.cursor)) : undefined,
  ].filter((condition) => condition !== undefined);

  return exec
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(filter.limit);
}

export async function unreadCount(userId: string, exec: Executor = db): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

  return row?.count ?? 0;
}

export async function markRead(
  userId: string,
  id: string,
  exec: Executor = db,
): Promise<NotificationRow | undefined> {
  const [row] = await exec
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.id, id), eq(notifications.userId, userId), isNull(notifications.readAt)),
    )
    .returning();

  return row;
}

export async function markAllRead(userId: string, exec: Executor = db): Promise<number> {
  const rows = await exec
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });

  return rows.length;
}

export async function preferences(
  userId: string,
  exec: Executor = db,
): Promise<NotificationPreferencesRow | undefined> {
  const [row] = await exec
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);

  return row;
}

export async function upsertPreferences(
  userId: string,
  patch: Partial<NotificationPreferencesRow>,
  exec: Executor = db,
): Promise<NotificationPreferencesRow> {
  const [row] = await exec
    .insert(notificationPreferences)
    .values({ userId, ...patch })
    .onConflictDoUpdate({ target: notificationPreferences.userId, set: patch })
    .returning();

  if (!row) throw new Error('notification preferences upsert returned no row');
  return row;
}
