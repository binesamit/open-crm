// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  dayCountOf,
  DEP_KINDS,
  type DepKind,
  type DepLink,
  type DepMode,
  moveSpanBy,
  planShifts,
  requiredShift,
  type Span,
  spanToValue,
  wouldCycle,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { accountWorkCalendar } from '../../lib/account-calendar';
import type { ColumnRow } from '../boards/boards.repo';
import { type BoardAccess, columnAllowed } from '../boards/boards.access';
import { columnCells, itemsByIds, type ItemRow } from './items.repo';
import { dependencyLinks } from './relations.repo';
import type { Actor } from './items.service';

/**
 * Dependency columns (M8 ד7, 03 §3.2, D25): links between items of the same board (item_links, `meta` = kind +
 * lag). A date change of a predecessor shifts its dependents per the column's mode, inside the same transaction and
 * batch as the edit itself — so one Ctrl+Z undoes the whole chain (the undo writes the old values back through
 * `writeCellTx`, which never shifts again).
 */

type DepSettings = { mode?: DepMode; date_column_id?: string };
const settingsOf = (c: ColumnRow) => (c.settings ?? {}) as DepSettings;
export const modeOf = (c: ColumnRow): DepMode => settingsOf(c).mode ?? 'flexible';

/** The date / timeline column a dependency column moves: its setting, else the first timeline, else first date. */
export const dateColumnOf = (dep: ColumnRow, columns: ColumnRow[]): ColumnRow | null => {
  const key = settingsOf(dep).date_column_id;
  const dated = (c: ColumnRow) => c.type === 'timeline' || c.type === 'date';
  return (
    (key ? columns.find((c) => c.key === key && dated(c)) : undefined) ??
    columns.find((c) => c.type === 'timeline') ??
    columns.find((c) => c.type === 'date') ??
    null
  );
};

/** Dependency columns an edit of `written` (column ids) may shift by: the links themselves or their date column. */
export const shiftTriggers = (columns: ColumnRow[], written: Set<string>) =>
  columns.filter((c) => {
    if (c.type !== 'dependency' || modeOf(c) === 'visual') return false;
    const date = dateColumnOf(c, columns);
    return !!date && (written.has(c.id) || written.has(date.id));
  });

/** A stored date / timeline value as a span (a date is one day); null when empty or invalid. */
export const spanOfValue = (value: unknown): Span | null => {
  const v = (value ?? {}) as { from?: string; to?: string; date?: string };
  if (v.from && v.to) return { from: v.from.slice(0, 10), to: v.to.slice(0, 10) };
  if (v.date) return { from: v.date.slice(0, 10), to: v.date.slice(0, 10) };
  return null;
};

const kindOf = (meta: unknown): DepKind => {
  const k = (meta as { kind?: string } | null)?.kind;
  return (DEP_KINDS as readonly string[]).includes(k ?? '') ? (k as DepKind) : 'FS';
};
const lagOf = (meta: unknown) => Number((meta as { lag_days?: number } | null)?.lag_days ?? 0) || 0;

/** The links of a dependency column as the shared engine reads them. */
export const loadDepLinks = async (db: Db, columnId: string): Promise<DepLink[]> =>
  (await dependencyLinks(db, columnId)).map((l) => ({
    item: l.from,
    on: l.to,
    kind: kindOf(l.meta),
    lag: lagOf(l.meta),
  }));

/**
 * Validates a dependency cell before it is written: targets on the item's own board, never the item itself, and no
 * loop through the column's other links (422 `dependency_cycle`). Returns the meta to store per target.
 */
export const checkDependencyValue = async (
  tx: Db,
  item: ItemRow,
  column: ColumnRow,
  value: { item_ids: string[]; kind?: Record<string, DepKind>; lag_days?: Record<string, number> },
  targets: ItemRow[],
) => {
  if (targets.some((t) => t.boardId !== item.boardId))
    throw new AppError('invalid_value', 'A dependency links items of the same board', { column_id: column.key });
  if (value.item_ids.includes(item.id))
    throw new AppError('dependency_cycle', 'An item cannot depend on itself', { column_id: column.key });
  if (wouldCycle(await loadDepLinks(tx, column.id), item.id, value.item_ids))
    throw new AppError('dependency_cycle', 'This dependency closes a loop', { column_id: column.key });
  return Object.fromEntries(
    value.item_ids.map((id) => {
      const kind = value.kind?.[id];
      const lag = value.lag_days?.[id];
      return [id, { ...(kind && kind !== 'FS' ? { kind } : {}), ...(lag ? { lag_days: lag } : {}) }];
    }),
  );
};

/** The cell cache of a dependency: ids plus only the non-default kinds and lags. */
export const dependencyCellValue = (ids: string[], meta: Record<string, Record<string, unknown>>) => {
  const kind = Object.fromEntries(ids.flatMap((id) => (meta[id]?.kind ? [[id, meta[id]!.kind]] : [])));
  const lag = Object.fromEntries(ids.flatMap((id) => (meta[id]?.lag_days ? [[id, meta[id]!.lag_days]] : [])));
  return {
    item_ids: ids,
    ...(Object.keys(kind).length ? { kind } : {}),
    ...(Object.keys(lag).length ? { lag_days: lag } : {}),
  };
};

type WriteCell = (
  tx: Db,
  a: Actor,
  access: BoardAccess,
  item: ItemRow,
  column: ColumnRow,
  raw: unknown,
  batchId: string | null,
  meta: Record<string, unknown>,
) => Promise<string>;

/**
 * After an edit of `item` (its cells before the edit: `before`, by column id; the columns it wrote: `written`),
 * shifts the dependents of every triggered dependency column. A changed date moves the item's dependents; a changed
 * dependency cell first moves
 * the item itself forward when the new links are broken (it cannot start before what it depends on), then its
 * dependents. Every shifted cell is a `cell.changed` in `batchId` with `meta.dependency_shift`. Returns the ids of
 * the items it moved.
 */
export const shiftDependents = async (
  tx: Db,
  a: Actor,
  access: BoardAccess,
  item: ItemRow,
  triggers: ColumnRow[],
  columns: ColumnRow[],
  before: Map<string, unknown>,
  written: Set<string>,
  batchId: string | null,
  writeCell: WriteCell,
): Promise<string[]> => {
  const shifted = new Set<string>();
  let work: Awaited<ReturnType<typeof accountWorkCalendar>> | null = null;
  for (const dep of triggers) {
    const dateColumn = dateColumnOf(dep, columns);
    if (!dateColumn || !columnAllowed(access, dateColumn.restrictedEdit)) continue;
    // Lags and shifts count days as the date column does (its duration, else the account's).
    work ??= await accountWorkCalendar(tx, a.ctx.accountId);
    const count = dayCountOf(
      dateColumn.settings as { duration?: string; keep_workdays?: boolean },
      work.calendar,
      work.weekend,
    );
    const links = await loadDepLinks(tx, dep.id);
    const values = new Map((await columnCells(tx, dateColumn.id)).map((c) => [c.itemId, c.value as unknown]));
    const spans = new Map<string, Span>();
    for (const [id, v] of values) {
      const span = spanOfValue(v);
      if (span) spans.set(id, span);
    }
    const now = spans.get(item.id);
    if (!now) continue;
    const was = spanOfValue(before.get(dateColumn.id)) ?? now;
    let after = now;
    const moved = new Map<string, { before: Span; after: Span }>();
    // New / changed links: the item itself must not break them (flexible and strict alike).
    if (written.has(dep.id)) {
      let need = 0;
      for (const l of links.filter((x) => x.item === item.id)) {
        const pred = spans.get(l.on);
        if (pred) need = Math.max(need, requiredShift(pred, after, l.kind, l.lag, count));
      }
      if (need > 0) {
        const fixed = moveSpanBy(after, need, count);
        await writeCell(
          tx,
          a,
          access,
          item,
          dateColumn,
          spanToValue(dateColumn.type, fixed, values.get(item.id)),
          batchId,
          {
            dependency_shift: { column_key: dep.key, item_id: item.id },
          },
        );
        values.set(item.id, spanToValue(dateColumn.type, fixed, values.get(item.id)));
        after = fixed;
      }
    }
    if (was.from === after.from && was.to === after.to) continue;
    moved.set(item.id, { before: was, after });
    spans.set(item.id, was);
    const plan = planShifts({ spans, links, moved, mode: modeOf(dep), count });
    if (!plan.size) continue;
    const rows = new Map(
      (await itemsByIds(tx, a.ctx.accountId, [...plan.keys()]))
        .filter((r) => r.boardId === item.boardId && !r.archivedAt)
        .map((r) => [r.id, r]),
    );
    for (const [id, span] of plan) {
      const row = rows.get(id);
      if (!row) continue;
      await writeCell(tx, a, access, row, dateColumn, spanToValue(dateColumn.type, span, values.get(id)), batchId, {
        dependency_shift: { column_key: dep.key, item_id: item.id },
      });
      shifted.add(id);
    }
  }
  return [...shifted];
};
