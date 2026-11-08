// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { activityLog, boards, columns, itemLinks, items } from '../../db/schema';
import { EVENTS_CHANNEL } from '../../lib/realtime';
import { anyId } from './items.repo';

/**
 * Computed item names: the boards whose name column computes names, links into items, and the batch
 * writes of a recompute.
 */

/** Name columns of live boards of the account whose `name_source` computes names (column / template). */
export const computedNameColumns = (db: Db, accountId: string) =>
  db
    .select({ boardId: columns.boardId, columnId: columns.id, settings: columns.settings })
    .from(columns)
    .innerJoin(boards, eq(boards.id, columns.boardId))
    .where(
      and(
        eq(columns.accountId, accountId),
        eq(columns.type, 'name'),
        isNull(columns.deletedAt),
        isNull(boards.deletedAt),
        sql`${columns.settings}->'name_source'->>'mode' in ('column', 'template')`,
      ),
    );

/** Links pointing at these items (any relation / dependency column): who shows their names. */
export const linkersOf = (db: Db, itemIds: string[]) =>
  itemIds.length
    ? db
        .select({ from: itemLinks.fromItemId, to: itemLinks.toItemId, columnId: itemLinks.columnId })
        .from(itemLinks)
        .where(anyId(itemLinks.toItemId, itemIds))
    : Promise.resolve([]);

/** New names for many items in one statement. */
export const setItemNames = async (db: Db, pairs: { id: string; name: string }[]) => {
  for (let i = 0; i < pairs.length; i += 1000) {
    const chunk = pairs.slice(i, i + 1000);
    await db.execute(sql`
      update ${items} set name = v.name, updated_at = now()
      from unnest(${sql.param(chunk.map((p) => p.id))}::varchar[], ${sql.param(chunk.map((p) => p.name))}::varchar[])
        as v(id, name)
      where ${items.id} = v.id`);
  }
};

/** `payload.after.name` of events not delivered yet (the `item.created` of an item whose name was computed after). */
export const setEventAfterNames = async (db: Db, pairs: { eventId: string; name: string }[]) => {
  for (let i = 0; i < pairs.length; i += 1000) {
    const chunk = pairs.slice(i, i + 1000);
    await db.execute(sql`
      update ${activityLog} set payload = jsonb_set(payload, '{after,name}', to_jsonb(v.name::text), true)
      from unnest(${sql.param(chunk.map((p) => p.eventId))}::varchar[], ${sql.param(chunk.map((p) => p.name))}::varchar[])
        as v(id, name)
      where ${activityLog.id} = v.id and ${activityLog.payload} ? 'after'`);
  }
};

/** A page of a board's live item ids (archived ones too: they keep a name), by id. */
export const boardItemIdsPage = async (db: Db, boardId: string, after: string | null, limit: number) =>
  (
    await db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.boardId, boardId), isNull(items.deletedAt), after ? gt(items.id, after) : undefined))
      .orderBy(asc(items.id))
      .limit(limit)
  ).map((r) => r.id);

export const countBoardLiveItems = async (db: Db, boardId: string) =>
  Number(
    (
      await db
        .select({ n: sql<number>`count(*)` })
        .from(items)
        .where(and(eq(items.boardId, boardId), isNull(items.deletedAt)))
    )[0]?.n ?? 0,
  );

/** Names shared by more than one active item of the board, the most shared first. */
export const duplicateNameGroups = async (db: Db, boardId: string, limit = 100) => {
  const rows = (
    (await db.execute(sql`
      select name, count(*)::int as count, (array_agg(id order by id))[1:20] as item_ids
      from ${items}
      where board_id = ${boardId} and deleted_at is null and archived_at is null and name <> ''
      group by name having count(*) > 1
      order by count(*) desc, name
      limit ${limit}`)) as unknown as { rows: { name: string; count: number; item_ids: string[] }[] }
  ).rows;
  const totals = (
    (await db.execute(sql`
      select count(*)::int as groups, coalesce(sum(n), 0)::int as items from (
        select count(*) as n from ${items}
        where board_id = ${boardId} and deleted_at is null and archived_at is null and name <> ''
        group by name having count(*) > 1) d`)) as unknown as { rows: { groups: number; items: number }[] }
  ).rows[0];
  return { rows, groups: totals?.groups ?? 0, items: totals?.items ?? 0 };
};

/** The board's recompute state (`boards.settings.name_recompute`), merged in without touching other settings. */
export const setNameRecomputeState = (db: Db, boardId: string, state: Record<string, unknown>) =>
  db
    .update(boards)
    .set({ settings: sql`${boards.settings} || ${JSON.stringify({ name_recompute: state })}::jsonb` })
    .where(eq(boards.id, boardId));

/** A recompute's progress on the board's live channel (no activity row: nothing to replay). */
export const announceNameRecompute = (db: Db, e: { accountId: string; boardId: string; columnId: string }) =>
  db.execute(
    sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify({
      id: '',
      account_id: e.accountId,
      type: 'board.names_recompute_progress',
      board_id: e.boardId,
      column_id: e.columnId,
    })})`,
  );

/** Only the stored text of a link cell (a dependency keeps its value with kinds and lags). */
export const setCellText = (db: Db, itemId: string, columnId: string, text: string) =>
  db.execute(sql`update cells set text_value = ${text} where item_id = ${itemId} and column_id = ${columnId}`);
