// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { newId } from '@bines/shared';
import type { Db } from '../../db/client';
import { activityLog } from '../../db/schema';
import { insertUnnest } from '../../db/unnest';
import { currentActivityScope } from '../../lib/activity-scope';

/**
 * Every mutation writes one activity_log row in the same transaction (CLAUDE.md rule 2). SSE, automations,
 * webhooks and undo read from here. `payload.before` makes an event reversible.
 */
export type ActivityEvent = {
  accountId: string;
  type: string;
  actorId: string | null;
  actorType?: 'user' | 'automation' | 'api' | 'system' | 'form' | 'email' | 'agent' | 'document';
  boardId?: string | null;
  itemId?: string | null;
  columnId?: string | null;
  batchId?: string | null;
  requestId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
};

const eventRow = (id: string, raw: ActivityEvent) => {
  // A request made by an extension (D27): its rows say so and share the request's batch (lib/activity-scope).
  const scope = currentActivityScope();
  const e = scope ? { ...raw, batchId: raw.batchId ?? scope.batchId, meta: { ...raw.meta, ...scope.meta } } : raw;
  return eventRowOf(id, e);
};

const eventRowOf = (id: string, e: ActivityEvent) => ({
  id,
  accountId: e.accountId,
  type: e.type,
  actorId: e.actorId,
  actorType: e.actorType ?? 'user',
  boardId: e.boardId ?? null,
  itemId: e.itemId ?? null,
  columnId: e.columnId ?? null,
  batchId: e.batchId ?? null,
  requestId: e.requestId ?? null,
  payload: {
    ...(e.before !== undefined ? { before: e.before } : {}),
    ...(e.after !== undefined ? { after: e.after } : {}),
    ...(e.meta ? { meta: e.meta } : {}),
  },
});

export const recordEvent = async (db: Db, e: ActivityEvent): Promise<string> => {
  const id = newId();
  await db.insert(activityLog).values(eventRow(id, e));
  return id;
};

/** Rows per `markUndoneMany` statement. */
const EVENTS_PER_STATEMENT = 2000;

/**
 * Many events at once (a bulk edit / file import of thousands of rows) through `insertUnnest`. Ids in input
 * order, strictly increasing — ULIDs of one millisecond are otherwise random, and the batch's order is its id order.
 * Triggers (realtime, automation dispatch) run per row as for `recordEvent`.
 */
export const recordEvents = async (db: Db, events: ActivityEvent[]): Promise<string[]> => {
  const ids = sortedIds(events.length);
  await insertUnnest(
    db,
    'activity_log',
    [
      ['id', 'varchar'],
      ['account_id', 'varchar'],
      ['type', 'varchar'],
      ['actor_id', 'varchar'],
      ['actor_type', 'actor_type'],
      ['board_id', 'varchar'],
      ['item_id', 'varchar'],
      ['column_id', 'varchar'],
      ['batch_id', 'varchar'],
      ['request_id', 'varchar'],
      ['payload', 'jsonb'],
    ],
    events.map((e, i) => {
      const r = eventRow(ids[i]!, e);
      return [
        r.id,
        r.accountId,
        r.type,
        r.actorId,
        r.actorType,
        r.boardId,
        r.itemId,
        r.columnId,
        r.batchId,
        r.requestId,
        JSON.stringify(r.payload),
      ];
    }),
  );
  return ids;
};

/** `n` fresh ULIDs in ascending order. */
const sortedIds = (n: number) => Array.from({ length: n }, () => newId()).sort();

export type ActivityRow = typeof activityLog.$inferSelect;

export const findEvent = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.accountId, accountId), eq(activityLog.id, id)))
      .limit(1)
  )[0];

/** Every event of one batch, newest first (undo walks them backwards). */
export const batchEvents = (db: Db, accountId: string, batchId: string) =>
  db
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.accountId, accountId), eq(activityLog.batchId, batchId)))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id));

/**
 * `created_at` narrows the key (id, created_at) to the event's partition. Postgres keeps microseconds and a JS Date
 * only milliseconds, so it is matched within a millisecond — never with `=` (that silently updated nothing).
 */
export const markUndone = (db: Db, ev: ActivityRow, byEventId: string) =>
  db
    .update(activityLog)
    .set({ undoneAt: new Date(), undoneByEventId: byEventId })
    .where(
      and(
        eq(activityLog.id, ev.id),
        gte(activityLog.createdAt, new Date(ev.createdAt.getTime() - 1)),
        lte(activityLog.createdAt, new Date(ev.createdAt.getTime() + 1)),
      ),
    );

/** `markUndone` for many events at once: each `[event, undone by]` (one statement per 2,000). */
export const markUndoneMany = async (db: Db, list: [ActivityRow, string][]) => {
  for (let i = 0; i < list.length; i += EVENTS_PER_STATEMENT) {
    const part = list.slice(i, i + EVENTS_PER_STATEMENT);
    const times = part.map(([ev]) => ev.createdAt.getTime());
    await db.execute(sql`
      update ${activityLog} a set undone_at = now(), undone_by_event_id = v.by
      from unnest(${sql.param(part.map(([ev]) => ev.id))}::varchar[], ${sql.param(part.map(([, by]) => by))}::varchar[]) as v(id, by)
      where a.id = v.id
        and a.created_at >= ${new Date(Math.min(...times) - 1).toISOString()}::timestamptz
        and a.created_at <= ${new Date(Math.max(...times) + 1).toISOString()}::timestamptz`);
  }
};
