// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  accountMembers,
  automations,
  boards,
  cells,
  columnConversionCells,
  columnConversions,
  columns,
  dashboardWidgets,
  dashboards,
  extensionInstallations,
  forms,
  importRefs,
  items,
  teams,
  users,
  views,
  webhooks,
} from '../../db/schema';
import { insertUnnest } from '../../db/unnest';
import { EVENTS_CHANNEL } from '../../lib/realtime';

/** Column type conversion (D28): the backup tables, the set-based writes and the dependents' lookups. */
export type ConversionRow = typeof columnConversions.$inferSelect;

export const insertConversion = (db: Db, row: typeof columnConversions.$inferInsert) =>
  db.insert(columnConversions).values(row);

export const updateConversion = (db: Db, id: string, patch: Partial<typeof columnConversions.$inferInsert>) =>
  db.update(columnConversions).set(patch).where(eq(columnConversions.id, id));

/** Conversions still `running` that started before `before` — interrupted by a crash (the sweep fails them). */
export const staleRunningConversions = (db: Db, before: Date) =>
  db
    .select({ id: columnConversions.id, columnId: columnConversions.columnId })
    .from(columnConversions)
    .where(and(eq(columnConversions.status, 'running'), lt(columnConversions.createdAt, before)));

export const findConversion = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(columnConversions)
      .where(and(eq(columnConversions.accountId, accountId), eq(columnConversions.id, id)))
      .limit(1)
  )[0];

export const conversionsOfBoard = (db: Db, boardId: string, columnId?: string, limit = 50) =>
  db
    .select()
    .from(columnConversions)
    .where(and(eq(columnConversions.boardId, boardId), columnId ? eq(columnConversions.columnId, columnId) : undefined))
    .orderBy(desc(columnConversions.createdAt))
    .limit(limit);

/** The latest conversion of a column that changed its type (done, not undone) — a later one must be undone first. */
export const latestDoneConversion = async (db: Db, columnId: string) =>
  (
    await db
      .select()
      .from(columnConversions)
      .where(and(eq(columnConversions.columnId, columnId), eq(columnConversions.status, 'done')))
      .orderBy(desc(columnConversions.createdAt))
      .limit(1)
  )[0];

/** A stored cell with its keys (read with plain SQL: jsonb arrives parsed once — a text "7" stays a string). */
export type StoredCell = {
  itemId: string;
  value: unknown;
  textValue: string | null;
  numberValue: number | null;
  dateValue: Date | null;
  dateEndValue: Date | null;
};
type RawStored = {
  item_id: string;
  value: unknown;
  text_value: string | null;
  number_value: number | string | null;
  date_value: Date | string | null;
  date_end_value: Date | string | null;
};
const asDate = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v : new Date(v));
const toStored = (r: RawStored): StoredCell => ({
  itemId: r.item_id,
  value: r.value,
  textValue: r.text_value,
  numberValue: r.number_value === null ? null : Number(r.number_value),
  dateValue: asDate(r.date_value),
  dateEndValue: asDate(r.date_end_value),
});
const rowsOf = <T>(res: unknown) => (res as { rows: T[] }).rows;

/** Every stored cell of a column with its keys, in item order (windows of a large conversion: `after`, `limit`). */
export const columnCellsPage = async (db: Db, columnId: string, after: string | null, limit: number) =>
  rowsOf<RawStored>(
    await db.execute(sql`
      select item_id, value, text_value, number_value, date_value, date_end_value from ${cells}
      where column_id = ${columnId} ${after ? sql`and item_id > ${after}` : sql``}
      order by item_id limit ${limit}`),
  ).map(toStored);

/** Items a conversion counts: every item of the board, archived and trashed included (product decision 4). */
export const countBoardItems = async (db: Db, boardId: string) =>
  (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(items)
      .where(eq(items.boardId, boardId))
  )[0]?.n ?? 0;

/** The newest change of the column's cells (the preview's fingerprint moves when anyone edits one). */
export const lastCellChange = async (db: Db, columnId: string) =>
  (
    await db
      .select({ at: sql<string | null>`max(${cells.updatedAt})::text` })
      .from(cells)
      .where(eq(cells.columnId, columnId))
  )[0]?.at ?? null;

export const itemNames = async (db: Db, ids: string[]) =>
  ids.length
    ? new Map(
        (
          await db
            .select({ id: items.id, name: items.name })
            .from(items)
            .where(sql`${items.id} = any(${sql.param(ids)}::varchar[])`)
        ).map((r) => [r.id, r.name]),
      )
    : new Map<string, string>();

export type BackupCell = {
  itemId: string;
  outcome: 'converted' | 'empty' | 'failed';
  partial: boolean;
  oldValue: unknown;
  oldText: string | null;
  oldNumber: number | null;
  oldDate: Date | null;
  oldDateEnd: Date | null;
  newValue: unknown;
  newText: string | null;
  newNumber: number | null;
  newDate: Date | null;
  newDateEnd: Date | null;
};

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
const iso = (d: Date | null) => d?.toISOString() ?? null;

/** One window of the backup (original value + the computed new one), thousands of rows per statement. */
export const insertBackupCells = (db: Db, accountId: string, conversionId: string, rows: BackupCell[]) =>
  insertUnnest(
    db,
    'column_conversion_cells',
    [
      ['conversion_id', 'varchar'],
      ['item_id', 'varchar'],
      ['account_id', 'varchar'],
      ['outcome', 'varchar'],
      ['partial', 'bool'],
      ['old_value', 'jsonb'],
      ['old_text', 'text'],
      ['old_number', 'float8'],
      ['old_date', 'timestamptz'],
      ['old_date_end', 'timestamptz'],
      ['new_value', 'jsonb'],
      ['new_text', 'text'],
      ['new_number', 'float8'],
      ['new_date', 'timestamptz'],
      ['new_date_end', 'timestamptz'],
    ],
    rows.map((r) => [
      conversionId,
      r.itemId,
      accountId,
      r.outcome,
      r.partial,
      json(r.oldValue),
      r.oldText,
      r.oldNumber,
      iso(r.oldDate),
      iso(r.oldDateEnd),
      json(r.newValue),
      r.newText,
      r.newNumber,
      iso(r.newDate),
      iso(r.newDateEnd),
    ]),
    sql`on conflict do nothing`,
  );

export type BackupRow = {
  itemId: string;
  outcome: string;
  oldValue: unknown;
  newValue: unknown;
  oldText: string | null;
};

/** Backup rows of a conversion, a page at a time (restore builds its own backup from them). */
export const backupPage = async (db: Db, conversionId: string, after: string | null, limit: number) =>
  rowsOf<{ item_id: string; outcome: string; old_value: unknown; new_value: unknown; old_text: string | null }>(
    await db.execute(sql`
      select item_id, outcome, old_value, new_value, old_text from ${columnConversionCells}
      where conversion_id = ${conversionId} ${after ? sql`and item_id > ${after}` : sql``}
      order by item_id limit ${limit}`),
  ).map((r): BackupRow => ({
    itemId: r.item_id,
    outcome: r.outcome,
    oldValue: r.old_value,
    newValue: r.new_value,
    oldText: r.old_text,
  }));

/**
 * The column's cells that the backup does not describe any more (a cell written while the backup was built — only
 * possible for writers that do not go through the cell service): new cells, or a value other than the backed-up one.
 */
export const cellsOutsideBackup = async (db: Db, columnId: string, conversionId: string) =>
  rowsOf<RawStored>(
    await db.execute(sql`
      select c.item_id, c.value, c.text_value, c.number_value, c.date_value, c.date_end_value from ${cells} c
      left join ${columnConversionCells} b on b.conversion_id = ${conversionId} and b.item_id = c.item_id
      where c.column_id = ${columnId} and (b.item_id is null or b.old_value is distinct from c.value)`),
  ).map(toStored);

export const deleteBackupRows = (db: Db, conversionId: string, itemIds: string[]) =>
  itemIds.length
    ? db
        .delete(columnConversionCells)
        .where(
          and(
            eq(columnConversionCells.conversionId, conversionId),
            sql`${columnConversionCells.itemId} = any(${sql.param(itemIds)}::varchar[])`,
          ),
        )
    : Promise.resolve();

/**
 * The switch, set-based (one transaction with the type change): the column's cells become the backup's new values
 * (`side: 'new'`) — or its original values (`side: 'old'`: an undo).
 */
export const replaceColumnCells = async (
  db: Db,
  input: { columnId: string; boardId: string; accountId: string; conversionId: string; userId: string | null },
  side: 'new' | 'old',
) => {
  await db.delete(cells).where(eq(cells.columnId, input.columnId));
  const p = side === 'new' ? 'new' : 'old';
  await db.execute(sql`
    insert into ${cells} (item_id, column_id, account_id, board_id, value, text_value, number_value, date_value,
      date_end_value, updated_by, updated_by_type)
    select b.item_id, ${input.columnId}, ${input.accountId}, ${input.boardId}, b.${sql.raw(`${p}_value`)},
      b.${sql.raw(`${p}_text`)}, b.${sql.raw(`${p}_number`)}, b.${sql.raw(`${p}_date`)}, b.${sql.raw(`${p}_date_end`)},
      ${input.userId}, 'user'
    from ${columnConversionCells} b
    join ${items} i on i.id = b.item_id
    where b.conversion_id = ${input.conversionId} and b.${sql.raw(`${p}_value`)} is not null`);
};

/** Cells that differ from what the conversion wrote (an undo asks before overwriting them). */
export const cellsChangedSince = async (db: Db, columnId: string, conversionId: string) =>
  (
    (await db.execute(sql`
      select count(*)::int as n from (select item_id, value from ${cells} where column_id = ${columnId}) c
      full join (select item_id, new_value from ${columnConversionCells}
        where conversion_id = ${conversionId} and new_value is not null) b using (item_id)
      where c.value is distinct from b.new_value`)) as { rows: { n: number }[] }
  ).rows[0]?.n ?? 0;

/** The failed cells of a board's marked conversions: conversion → item → the original value as text. */
export const failedCells = async (db: Db, boardId: string, since: Date) =>
  rowsOf<{ conversion_id: string; item_id: string; old_text: string | null; old_value: unknown }>(
    await db.execute(sql`
      select b.conversion_id, b.item_id, b.old_text, b.old_value from ${columnConversionCells} b
      join ${columnConversions} c on c.id = b.conversion_id
      where c.board_id = ${boardId} and c.status = 'done' and c.failed_cleared_at is null
        and c.backup_purged_at is null and c.created_at > ${since.toISOString()}::timestamptz
        and b.outcome = 'failed'
      limit 20000`),
  ).map((r) => ({ conversionId: r.conversion_id, itemId: r.item_id, oldText: r.old_text, oldValue: r.old_value }));

export const setColumnConverting = (db: Db, columnId: string, conversionId: string | null) =>
  db.update(columns).set({ convertingId: conversionId }).where(eq(columns.id, columnId));

/** Progress of a background conversion on the board's live channel (no activity row: nothing to replay). */
export const announceProgress = (
  db: Db,
  e: { accountId: string; boardId: string; columnId: string; conversionId: string },
) =>
  db.execute(
    sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify({
      id: '',
      account_id: e.accountId,
      type: 'column.conversion_progress',
      board_id: e.boardId,
      column_id: e.columnId,
      batch_id: e.conversionId,
    })})`,
  );

// ---- the environment of a conversion ----

/** Active people (name + email) and teams of the account (people ↔ text). */
export const accountPeople = async (db: Db, accountId: string) => {
  const persons = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(accountMembers)
    .innerJoin(users, eq(users.id, accountMembers.userId))
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.status, 'active'), eq(users.isService, false)),
    );
  const teamRows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(and(eq(teams.accountId, accountId), isNull(teams.deletedAt)));
  return [
    ...persons.map((p) => ({ id: p.id, kind: 'person' as const, name: p.name || p.email, email: p.email })),
    ...teamRows.map((t) => ({ id: t.id, kind: 'team' as const, name: t.name })),
  ];
};

// ---- dependents ----

/** Live columns of the account of some types (formulas, mirrors, AI columns, relations…). */
export const accountColumnsOfTypes = (db: Db, accountId: string, types: string[]) =>
  db
    .select({
      id: columns.id,
      boardId: columns.boardId,
      key: columns.key,
      type: columns.type,
      title: columns.title,
      settings: columns.settings,
      boardName: boards.name,
      parentBoardId: boards.parentBoardId,
    })
    .from(columns)
    .innerJoin(boards, eq(boards.id, columns.boardId))
    .where(
      and(
        eq(columns.accountId, accountId),
        isNull(columns.deletedAt),
        isNull(boards.deletedAt),
        sql`${columns.type} = any(${sql.param(types)}::varchar[])`,
      ),
    );

export const boardViews = (db: Db, boardId: string) =>
  db
    .select()
    .from(views)
    .where(and(eq(views.boardId, boardId), isNull(views.deletedAt)));

export const updateViewSettings = (db: Db, id: string, settings: Record<string, unknown>) =>
  db
    .update(views)
    .set({ settings, revision: sql`${views.revision} + 1`, updatedAt: new Date() })
    .where(eq(views.id, id));

export const findView = async (db: Db, id: string) =>
  (await db.select().from(views).where(eq(views.id, id)).limit(1))[0];

export const boardAutomations = (db: Db, boardId: string) =>
  db
    .select()
    .from(automations)
    .where(and(eq(automations.boardId, boardId), isNull(automations.deletedAt)));

export const setAutomationActive = (db: Db, id: string, active: boolean, reason: string | null) =>
  db
    .update(automations)
    .set({ isActive: active, deactivatedReason: reason, updatedAt: new Date() })
    .where(eq(automations.id, id));

export const findAutomation = async (db: Db, id: string) =>
  (await db.select().from(automations).where(eq(automations.id, id)).limit(1))[0];

/** Widgets whose settings name the board (a widget reads several boards; its settings list their ids). */
export const widgetsOfBoard = (db: Db, accountId: string, boardId: string) =>
  db
    .select({
      id: dashboardWidgets.id,
      title: dashboardWidgets.title,
      type: dashboardWidgets.type,
      settings: dashboardWidgets.settings,
      updatedAt: dashboardWidgets.updatedAt,
      dashboardName: dashboards.name,
    })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(
      and(
        eq(dashboardWidgets.accountId, accountId),
        isNull(dashboardWidgets.deletedAt),
        isNull(dashboards.deletedAt),
        sql`${dashboardWidgets.settings}::text like ${`%${boardId}%`}`,
      ),
    );

export const updateWidgetSettings = (db: Db, id: string, settings: Record<string, unknown>) =>
  db.update(dashboardWidgets).set({ settings, updatedAt: new Date() }).where(eq(dashboardWidgets.id, id));

export const findWidget = async (db: Db, id: string) =>
  (await db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, id)).limit(1))[0];

/** Extension installations of the account that may hold settings about the column (they get a "review" mark). */
export const installationsMentioning = (db: Db, accountId: string, needle: string) =>
  db
    .select({ id: extensionInstallations.id, key: extensionInstallations.key, state: extensionInstallations.state })
    .from(extensionInstallations)
    .where(
      and(
        eq(extensionInstallations.accountId, accountId),
        sql`${extensionInstallations.state}::text like ${`%${needle}%`}`,
      ),
    );

export const boardWebhooks = (db: Db, boardId: string) =>
  db
    .select({ id: webhooks.id, eventType: webhooks.eventType, config: webhooks.config })
    .from(webhooks)
    .where(and(eq(webhooks.boardId, boardId), isNull(webhooks.deletedAt)));

export const formsOfBoard = (db: Db, boardId: string) =>
  db
    .select({ id: forms.id, title: forms.title, questions: forms.questions })
    .from(forms)
    .where(eq(forms.boardId, boardId));

/** Importers that map a source field into this column (a re-run converts through text). */
export const importRefsOf = (db: Db, accountId: string, columnId: string) =>
  db
    .select({ id: importRefs.id, source: importRefs.source })
    .from(importRefs)
    .where(
      and(eq(importRefs.accountId, accountId), eq(importRefs.entityType, 'column'), eq(importRefs.entityId, columnId)),
    );

// ---- backup retention ----

/** Conversions whose backup is older than `before` (per account retention), not yet purged. */
export const conversionsToPurge = (db: Db, accountId: string, before: Date) =>
  db
    .select({ id: columnConversions.id })
    .from(columnConversions)
    .where(
      and(
        eq(columnConversions.accountId, accountId),
        isNull(columnConversions.backupPurgedAt),
        lt(columnConversions.createdAt, before),
        sql`${columnConversions.status} <> 'running'`,
      ),
    );

export const accountsWithBackups = async (db: Db) =>
  (
    await db
      .selectDistinct({ accountId: columnConversions.accountId })
      .from(columnConversions)
      .where(isNull(columnConversions.backupPurgedAt))
  ).map((r) => r.accountId);

export const purgeBackup = async (db: Db, conversionId: string) => {
  await db.delete(columnConversionCells).where(eq(columnConversionCells.conversionId, conversionId));
  await db.update(columnConversions).set({ backupPurgedAt: new Date() }).where(eq(columnConversions.id, conversionId));
};
