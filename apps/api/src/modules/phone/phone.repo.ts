// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { cells, columns, updates } from '../../db/schema';

/** Plan — phone cells (E.164 backfill / re-normalisation) and SMS usage counts. */

export type PhoneCellRow = {
  itemId: string;
  columnId: string;
  accountId: string;
  value: unknown;
  settings: Record<string, unknown>;
};

/**
 * One page of phone cells (every account, or one), ordered by (column, item) — the backfill walks them with a
 * keyset cursor so it never holds a whole table.
 */
export const phoneCellsPage = (
  db: Db,
  after: { columnId: string; itemId: string } | null,
  limit: number,
  accountId?: string,
): Promise<PhoneCellRow[]> =>
  db
    .select({
      itemId: cells.itemId,
      columnId: cells.columnId,
      accountId: cells.accountId,
      value: cells.value,
      settings: columns.settings,
    })
    .from(cells)
    .innerJoin(columns, eq(columns.id, cells.columnId))
    .where(
      and(
        eq(columns.type, 'phone'),
        accountId ? eq(cells.accountId, accountId) : undefined,
        after
          ? or(
              gt(cells.columnId, after.columnId),
              and(eq(cells.columnId, after.columnId), gt(cells.itemId, after.itemId)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(cells.columnId), asc(cells.itemId))
    .limit(limit) as Promise<PhoneCellRow[]>;

/** Every stored cell of one column (re-normalising after its default country changed). */
export const columnPhoneCells = (db: Db, columnId: string) =>
  db.select({ itemId: cells.itemId, value: cells.value }).from(cells).where(eq(cells.columnId, columnId));

/**
 * Rewrites the stored value of many cells, 500 per statement. Only derived keys change (the text, number and date
 * keys stay), so no event is recorded — what people see does not move.
 */
export const updateCellValues = async (db: Db, rows: { itemId: string; columnId: string; value: unknown }[]) => {
  for (let i = 0; i < rows.length; i += 500) {
    const values = sql.join(
      rows
        .slice(i, i + 500)
        .map((r) => sql`(${r.itemId}::varchar, ${r.columnId}::varchar, ${JSON.stringify(r.value)}::jsonb)`),
      sql`, `,
    );
    await db.execute(sql`
      UPDATE ${cells} SET value = v.value
      FROM (VALUES ${values}) AS v(item_id, column_id, value)
      WHERE ${cells.itemId} = v.item_id AND ${cells.columnId} = v.column_id`);
  }
};

/**
 * SMS sent since `since` (updates with source `sms`, deleted ones too — the money was spent). `userId`: only that
 * person's own sends (an automation's sends count for the account only).
 */
export const countSms = async (db: Db, accountId: string, since: Date, userId?: string) => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(updates)
    .where(
      and(
        eq(updates.accountId, accountId),
        eq(updates.source, 'sms'),
        gt(updates.createdAt, since),
        userId ? eq(updates.createdBy, userId) : undefined,
        userId ? isNull(sql`${updates.meta}->'sms'->>'automation_id'`) : undefined,
      ),
    );
  return row?.n ?? 0;
};
