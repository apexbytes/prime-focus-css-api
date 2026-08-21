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

// -- the daily digest --------------------------------------------------------

export interface DigestCandidate {
  userId: string;
  fullName: string;
  email: string;
  unreadNotifications: number;
  assignedOpen: number;
}

/**
 * Everyone the digest has something to say to.
 *
 * One statement rather than a query per agent, because this runs for every
 * active account at 07:00 and N+1 across three tables would make the job's
 * duration a function of headcount.
 *
 * The preference row is left-joined and defaulted to true: an agent who has
 * never opened the preferences screen has no row, and excluding them would mean
 * the digest only ever reached people who had already thought about it.
 *
 * `having` rather than filtering in TypeScript: an agent with nothing waiting
 * gets no email, and a daily "you have nothing" is how a digest gets filtered
 * to a folder nobody reads.
 */
export async function digestCandidates(exec: Executor = db): Promise<DigestCandidate[]> {
  const result = await exec.execute(sql`
    select
      u.id                as "userId",
      u.full_name         as "fullName",
      u.email             as email,
      coalesce(n.unread, 0)::int   as "unreadNotifications",
      coalesce(t.assigned, 0)::int as "assignedOpen"
    from users u
    left join notification_preferences p on p.user_id = u.id
    left join (
      select user_id, count(*) as unread
      from notifications
      where read_at is null
      group by user_id
    ) n on n.user_id = u.id
    left join (
      select assigned_to_user_id as user_id, count(*) as assigned
      from tickets
      where deleted_at is null
        and status in ('new', 'open', 'pending', 'on_hold')
        and assigned_to_user_id is not null
      group by assigned_to_user_id
    ) t on t.user_id = u.id
    where u.status = 'active'
      and coalesce(p.email_digest, true)
      and (coalesce(n.unread, 0) > 0 or coalesce(t.assigned, 0) > 0)
    order by u.email
  `);

  return result.rows as unknown as DigestCandidate[];
}

export interface DigestTicket {
  userId: string;
  reference: string;
  subject: string;
}

/**
 * Tickets on these agents' queues that are past their deadline or about to be.
 *
 * Two hours' warning, in wall-clock time rather than working time: the digest
 * goes out before the desk opens, so "due in two working hours" would include
 * everything due before lunch and drown the actually-late ones.
 *
 * Ordered by deadline so the caller can take the first few per agent and know
 * they are the most urgent.
 */
export async function breachingForUsers(
  userIds: readonly string[],
  exec: Executor = db,
): Promise<DigestTicket[]> {
  if (userIds.length === 0) return [];

  const result = await exec.execute(sql`
    select distinct on (t.id)
      t.assigned_to_user_id as "userId",
      t.reference           as reference,
      t.subject             as subject,
      g.due_at              as due_at
    from tickets t
    join ticket_sla_targets g on g.ticket_id = t.id
    where t.assigned_to_user_id = any(${sql.param([...userIds])}::uuid[])
      and t.deleted_at is null
      and g.satisfied_at is null
      and g.paused_at is null
      and g.due_at < now() + interval '2 hours'
    order by t.id, g.due_at asc
  `);

  return (result.rows as unknown as (DigestTicket & { due_at: Date })[])
    .sort((left, right) => left.due_at.getTime() - right.due_at.getTime())
    .map(({ userId, reference, subject }) => ({ userId, reference, subject }));
}
