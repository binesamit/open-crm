// SPDX-License-Identifier: AGPL-3.0-only
import { type AnyColumn, and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { newId } from '@bines/shared';
import { accountMembers, cells, itemLinks, items, users } from '../../db/schema';
import { insertUnnest } from '../../db/unnest';
import { assertWithinLimit } from '../billing/entitlements';

export type ItemRow = typeof items.$inferSelect;

/**
 * `column = any($1)` with the ids as ONE array parameter. `inArray` sends one parameter per id: for a 30k-item
 * board that is 30k placeholders for Drizzle to build and Postgres to parse and plan (perf review: ~1 s of a
 * board load). Same result; empty list → no rows.
 */
export const anyId = (column: AnyColumn, ids: string[]) =>
  ids.length ? sql`${column} = any(${sql.param(ids)}::varchar[])` : sql`false`;
export type CellRow = typeof cells.$inferSelect;

/**
 * Board order: depth, then position (code-unit order = the "C" collation; keys are [0-9a-z|]), then id — two rows
 * that got the same key (older concurrent appends, audit 2026-10-10 C5) keep one order between loads.
 */
export const byDepthPosition = (x: ItemRow, y: ItemRow) =>
  x.depth - y.depth ||
  (x.position < y.position ? -1 : x.position > y.position ? 1 : 0) ||
  (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * Live items of a board in board order. Sorted here, not in SQL: on a 30k-item board Postgres spilled the sort
 * of the long position keys to disk (~150 ms per load, perf review); in memory it takes a few ms.
 */
export const listBoardItems = async (db: Db, boardId: string) =>
  (
    await db
      .select()
      .from(items)
      .where(and(eq(items.boardId, boardId), isNull(items.deletedAt), isNull(items.archivedAt)))
  ).sort(byDepthPosition);

export const findItem = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(items)
      .where(and(eq(items.accountId, accountId), eq(items.id, id), isNull(items.deletedAt)))
      .limit(1)
  )[0];

/**
 * `findItem` for a row that may already be in the trash: an `item_deleted` automation run reads the item it lost,
 * so "notify … {item.name}" still has a name (audit 2026-10-10, automations #2). Read-only callers only.
 */
export const findItemEvenDeleted = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(items)
      .where(and(eq(items.accountId, accountId), eq(items.id, id)))
      .limit(1)
  )[0];

export const itemCells = (db: Db, itemId: string) => db.select().from(cells).where(eq(cells.itemId, itemId));

export const lastItemPosition = async (db: Db, groupId: string) =>
  (
    await db
      .select({ p: items.position })
      .from(items)
      .where(and(eq(items.groupId, groupId), isNull(items.deletedAt), eq(items.depth, 0)))
      .orderBy(desc(items.position))
      .limit(1)
  )[0]?.p ?? null;

export const firstItemPosition = async (db: Db, groupId: string) =>
  (
    await db
      .select({ p: items.position })
      .from(items)
      .where(and(eq(items.groupId, groupId), isNull(items.deletedAt), eq(items.depth, 0)))
      .orderBy(asc(items.position))
      .limit(1)
  )[0]?.p ?? null;

/**
 * Positions of an item and its next sibling in the same group, for "after_id" placement. The anchor must be a live
 * top-level item of that group (audit 2026-10-10 C6: any id used to do); null = not a sibling. The successor
 * follows the board order (position, then id), so an anchor that shares its key with another row still gets its
 * true neighbour.
 */
export const neighbourPositions = async (db: Db, groupId: string, afterItemId: string) => {
  const anchor = (
    await db
      .select({ p: items.position })
      .from(items)
      .where(and(eq(items.id, afterItemId), eq(items.groupId, groupId), isNull(items.deletedAt), eq(items.depth, 0)))
      .limit(1)
  )[0]?.p;
  if (!anchor) return null;
  const next = (
    await db
      .select({ p: items.position })
      .from(items)
      .where(
        and(
          eq(items.groupId, groupId),
          isNull(items.deletedAt),
          eq(items.depth, 0),
          sql`(${items.position} > ${anchor} or (${items.position} = ${anchor} and ${items.id} > ${afterItemId}))`,
        ),
      )
      .orderBy(asc(items.position), asc(items.id))
      .limit(1)
  )[0]?.p;
  return { before: anchor, after: next ?? null };
};

/**
 * Every new item passes the plan's item limit here
 * — the API, bulk / import, forms, automations, agents, MCP, inbound webhooks, Make / n8n,
 * templates and copies all create items through these two.
 */
export const insertItem = async (db: Db, row: typeof items.$inferInsert) => {
  await assertWithinLimit(db, row.accountId, 'items', 1);
  return db.insert(items).values(row);
};

/** Many new items / cells at once (bulk edit, file import): `insertUnnest`, a few statements in all. */
export const insertItems = async (db: Db, rows: (typeof items.$inferInsert)[]) => {
  if (rows.length) {
    await assertWithinLimit(db, rows[0]!.accountId, 'items', rows.length);
  }
  return insertItemRows(db, rows);
};
const insertItemRows = (db: Db, rows: (typeof items.$inferInsert)[]) =>
  insertUnnest(
    db,
    'items',
    [
      ['id', 'varchar'],
      ['account_id', 'varchar'],
      ['board_id', 'varchar'],
      ['group_id', 'varchar'],
      ['parent_item_id', 'varchar'],
      ['root_item_id', 'varchar'],
      ['depth', 'int'],
      ['position', 'text'],
      ['name', 'varchar'],
      ['key_seq', 'int'],
      ['created_by', 'varchar'],
      ['creator_type', 'actor_type'],
      ['last_cell_change_at', 'timestamptz'],
      ['last_cell_change_by', 'varchar'],
    ],
    rows.map((r) => [
      r.id,
      r.accountId,
      r.boardId,
      r.groupId,
      r.parentItemId ?? null,
      r.rootItemId ?? null,
      r.depth ?? 0,
      r.position,
      r.name,
      r.keySeq,
      r.createdBy,
      r.creatorType ?? 'user',
      r.lastCellChangeAt?.toISOString() ?? null,
      r.lastCellChangeBy,
    ]),
  );
export const insertCells = (db: Db, rows: (typeof cells.$inferInsert)[]) =>
  insertUnnest(
    db,
    'cells',
    [
      ['item_id', 'varchar'],
      ['column_id', 'varchar'],
      ['account_id', 'varchar'],
      ['board_id', 'varchar'],
      ['value', 'jsonb'],
      ['text_value', 'text'],
      ['number_value', 'float8'],
      ['date_value', 'timestamptz'],
      ['date_end_value', 'timestamptz'],
      ['updated_by', 'varchar'],
      ['updated_by_type', 'actor_type'],
    ],
    rows.map((r) => [
      r.itemId,
      r.columnId,
      r.accountId,
      r.boardId,
      JSON.stringify(r.value),
      r.textValue,
      r.numberValue,
      r.dateValue?.toISOString() ?? null,
      r.dateEndValue?.toISOString() ?? null,
      r.updatedBy,
      r.updatedByType ?? 'user',
    ]),
  );
export const updateItemRow = (db: Db, id: string, patch: Partial<typeof items.$inferInsert>) =>
  db
    .update(items)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(items.id, id));

export const softDeleteItemsInGroup = (db: Db, groupId: string) =>
  db
    .update(items)
    .set({ deletedAt: new Date() })
    .where(and(eq(items.groupId, groupId), isNull(items.deletedAt)))
    .returning({ id: items.id });

export const upsertCell = (db: Db, row: typeof cells.$inferInsert) =>
  db
    .insert(cells)
    .values(row)
    .onConflictDoUpdate({
      target: [cells.itemId, cells.columnId],
      set: {
        value: row.value,
        textValue: row.textValue,
        numberValue: row.numberValue,
        dateValue: row.dateValue,
        dateEndValue: row.dateEndValue,
        updatedAt: new Date(),
        updatedBy: row.updatedBy,
        updatedByType: row.updatedByType,
      },
    });

/** Every stored cell of a column, deleted items included (label reconciliation and re-derivation). */
export const columnCells = (db: Db, columnId: string) =>
  db.select({ itemId: cells.itemId, value: cells.value }).from(cells).where(eq(cells.columnId, columnId));

/** Rewrites the text/number keys of many cells of one column (after its labels changed), 500 per statement. */
export const updateCellKeys = async (
  db: Db,
  columnId: string,
  rows: { itemId: string; textValue: string | null; numberValue: number | null }[],
) => {
  for (let i = 0; i < rows.length; i += 500) {
    const values = sql.join(
      rows.slice(i, i + 500).map((r) => sql`(${r.itemId}::varchar, ${r.textValue}::text, ${r.numberValue}::float8)`),
      sql`, `,
    );
    await db.execute(sql`
      UPDATE ${cells} SET text_value = v.t, number_value = v.n
      FROM (VALUES ${values}) AS v(item_id, t, n)
      WHERE ${cells.columnId} = ${columnId} AND ${cells.itemId} = v.item_id`);
  }
};

/** Distinct display values of a column, most used first (text suggestions, 03 §2.2). */
/** `itemIds`: only these items (the ones the actor may see); null = all. */
export const columnValueCounts = (db: Db, columnId: string, q: string, itemIds: string[] | null, limit = 20) =>
  db
    .select({ value: cells.textValue, count: sql<number>`count(*)::int` })
    .from(cells)
    .innerJoin(items, eq(items.id, cells.itemId))
    .where(
      and(
        eq(cells.columnId, columnId),
        isNull(items.deletedAt),
        isNull(items.archivedAt),
        itemIds ? anyId(items.id, itemIds) : undefined,
        sql`${cells.textValue} is not null and ${cells.textValue} <> ''`,
        // Typed % and _ are literal characters, not wildcards.
        q ? sql`${cells.textValue} ilike ${`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}` : undefined,
      ),
    )
    .groupBy(cells.textValue)
    .orderBy(desc(sql`count(*)`), asc(cells.textValue))
    .limit(limit);

export const deleteCell = (db: Db, itemId: string, columnId: string) =>
  db.delete(cells).where(and(eq(cells.itemId, itemId), eq(cells.columnId, columnId)));

/** Names of active members (people cells toText). */
export const memberNames = async (db: Db, accountId: string, userIds: string[]) => {
  if (!userIds.length) return new Map<string, string>();
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .innerJoin(accountMembers, and(eq(accountMembers.userId, users.id), eq(accountMembers.accountId, accountId)))
    .where(inArray(users.id, userIds));
  return new Map(rows.map((r) => [r.id, r.name || r.email]));
};

export const isAccountMember = async (db: Db, accountId: string, userIds: string[]) => {
  if (!userIds.length) return true;
  const rows = await db
    .select({ id: accountMembers.userId })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.status, 'active'),
        inArray(accountMembers.userId, userIds),
      ),
    );
  return rows.length === new Set(userIds).size;
};

// ---- batch loads for computed columns (relations, mirrors, formulas) ----
export const itemsByIds = (db: Db, accountId: string, ids: string[]) =>
  ids.length
    ? db
        .select()
        .from(items)
        .where(and(eq(items.accountId, accountId), anyId(items.id, ids), isNull(items.deletedAt)))
    : Promise.resolve([] as ItemRow[]);

/** Live children (subitems) of these items, in order — mirrors over subitems (D14). */
export const childItemsOf = (db: Db, parentIds: string[]) =>
  parentIds.length
    ? db
        .select()
        .from(items)
        .where(and(anyId(items.parentItemId, parentIds), isNull(items.deletedAt)))
        .orderBy(asc(items.position))
    : Promise.resolve([] as ItemRow[]);

export const cellsByItemIds = (db: Db, ids: string[]) =>
  ids.length ? db.select().from(cells).where(anyId(cells.itemId, ids)) : Promise.resolve([] as CellRow[]);

/** What reading a cell needs (the calculator): no timestamps or sort keys to map — 200k cells on a big board. */
export type CellValueRow = Pick<CellRow, 'itemId' | 'columnId' | 'value' | 'textValue'>;
type RawCell = { item_id: string; column_id: string; value: unknown; text_value: string | null };
const toCellValue = (r: RawCell): CellValueRow => ({
  itemId: r.item_id,
  columnId: r.column_id,
  value: r.value as CellRow['value'],
  textValue: r.text_value,
});

// Plain execute: the driver's rows without Drizzle's per-field mapping, which doubled the time (167k cells:
// ~1.1 s → ~0.5 s). jsonb arrives parsed.
export const cellValuesByItemIds = async (db: Db, ids: string[]): Promise<CellValueRow[]> => {
  if (!ids.length) return [];
  const res = await db.execute(
    sql`select item_id, column_id, value, text_value from ${cells} where ${anyId(cells.itemId, ids)}`,
  );
  return (res as unknown as { rows: RawCell[] }).rows.map(toCellValue);
};

/** Every cell of a board (a whole-board load: one range of ix_cells_board instead of 30k ids). */
export const cellValuesByBoard = async (db: Db, boardId: string): Promise<CellValueRow[]> => {
  const res = await db.execute(
    sql`select item_id, column_id, value, text_value from ${cells} where ${cells.boardId} = ${boardId}`,
  );
  return (res as unknown as { rows: RawCell[] }).rows.map(toCellValue);
};

export type LinkRow = typeof itemLinks.$inferSelect;

export const linksFromItems = (db: Db, ids: string[]) =>
  ids.length
    ? db.select().from(itemLinks).where(anyId(itemLinks.fromItemId, ids)).orderBy(asc(itemLinks.position))
    : Promise.resolve([] as LinkRow[]);

/** Replaces the links of one relation cell (item_links is the truth; the cell value is a cache). */
export const replaceLinks = async (
  db: Db,
  p: {
    accountId: string;
    columnId: string;
    fromItemId: string;
    toItemIds: string[];
    createdBy: string;
    /** Per target (dependency kind + lag, M8 ד7); missing = '{}'. */
    meta?: Record<string, Record<string, unknown>>;
  },
) => {
  await db.delete(itemLinks).where(and(eq(itemLinks.columnId, p.columnId), eq(itemLinks.fromItemId, p.fromItemId)));
  if (!p.toItemIds.length) return;
  await db.insert(itemLinks).values(
    p.toItemIds.map((to, i) => ({
      id: newId(),
      accountId: p.accountId,
      columnId: p.columnId,
      fromItemId: p.fromItemId,
      toItemId: to,
      position: String(i).padStart(4, '0'),
      meta: p.meta?.[to] ?? {},
      createdBy: p.createdBy,
    })),
  );
};

/** Name search for the relation picker (06 §2.12), limited to one board. */
export const searchItemsByName = (db: Db, boardId: string, q: string, limit = 30, offset = 0) =>
  db
    .select({ id: items.id, name: items.name, boardId: items.boardId, groupId: items.groupId })
    .from(items)
    .where(
      and(
        eq(items.boardId, boardId),
        isNull(items.deletedAt),
        isNull(items.archivedAt),
        // A typed `%` / `_` is literal, as in the cell search above (audit 2026-10-10 security #25).
        q ? sql`${items.name} ilike ${`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}` : undefined,
      ),
    )
    .orderBy(asc(items.name), asc(items.id))
    .limit(limit)
    .offset(offset);

/** Rank of the last live child of an item (new subitems go to the bottom). */
export const lastChildPosition = async (db: Db, parentItemId: string) =>
  (
    await db
      .select({ p: items.position })
      .from(items)
      .where(and(eq(items.parentItemId, parentItemId), isNull(items.deletedAt)))
      .orderBy(desc(items.position))
      .limit(1)
  )[0]?.p ?? null;

/** Live, not archived top-level items of a group, in order (duplicating a group). */
export const activeItemsOfGroupRows = (db: Db, groupId: string) =>
  db
    .select()
    .from(items)
    .where(and(eq(items.groupId, groupId), isNull(items.deletedAt), isNull(items.archivedAt)))
    .orderBy(asc(items.position));
