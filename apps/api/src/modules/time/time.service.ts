// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  columnTypes,
  deriveValues,
  newId,
  validateEntryRange,
  type TimeEntry,
  type TimeSettings,
  type TimeValue,
} from '@bines/shared';
import type { z } from 'zod';
import type { addTimeEntrySchema, updateTimeEntrySchema } from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, columnAllowed, isOwnerOrAdmin } from '../boards/boards.access';
import { findColumnById, findColumnByKey, type ColumnRow } from '../boards/boards.repo';
import { deleteCell, isAccountMember, upsertCell } from '../items/items.repo';
import { loadItem } from '../items/items.service';
import {
  cellEntries,
  findNamedEntry,
  insertEntry,
  itemOfEntry,
  listItemEntries,
  runningEntriesOf,
  updateEntry,
  type NamedEntry,
} from './time.repo';

const dto = (r: NamedEntry, columnKey: string): TimeEntry => ({
  id: r.entry.id,
  item_id: r.entry.itemId,
  column_id: columnKey,
  user: r.entry.userId ? { id: r.entry.userId, name: r.userName || r.userEmail || '' } : null,
  started_at: r.entry.startedAt.toISOString(),
  ended_at: r.entry.endedAt?.toISOString() ?? null,
  duration_s: r.entry.durationS ?? null,
  source: r.entry.source,
  note: r.entry.note,
  billable: r.entry.billable,
  edited_by: r.entry.editedBy ? { id: r.entry.editedBy, name: r.editorName || r.editorEmail || '' } : null,
  edited_at: r.entry.editedAt?.toISOString() ?? null,
});

const keyOf = async (db: Db, columnId: string) => (await findColumnById(db, columnId))?.key ?? columnId;

/**
 * Rewrites the cell cache from the entries (03 §3.3): closed seconds, entry count and the latest running timer.
 * Runs in the same transaction as the entry change.
 */
export const syncTimeCell = async (tx: Db, a: Actor, item: { id: string; boardId: string }, column: ColumnRow) => {
  const rows = await cellEntries(tx, item.id, column.id);
  if (!rows.length) {
    await deleteCell(tx, item.id, column.id);
    return;
  }
  const running = rows.filter((r) => !r.endedAt);
  const value: TimeValue = {
    duration: rows.reduce((sum, r) => sum + (r.durationS ?? 0), 0),
    running: running.length > 0,
    ...(running.length
      ? { runners: running.map((r) => ({ user_id: r.userId, since: r.startedAt.toISOString() })) }
      : {}),
    entries_count: rows.length,
  };
  const derived = deriveValues(columnTypes.get('time_tracking')!, column.settings, value);
  await upsertCell(tx, {
    itemId: item.id,
    columnId: column.id,
    accountId: a.ctx.accountId,
    boardId: item.boardId,
    value: value as unknown as Record<string, unknown>,
    textValue: derived.textValue,
    numberValue: derived.numberValue,
    dateValue: null,
    dateEndValue: null,
    updatedBy: a.user.id,
    updatedByType: 'user',
  });
};

/** The item + its time column; writing needs `item.update` and respects column edit restrictions. */
const loadTimeColumn = async (db: Db, a: Actor, itemId: string, columnKey: string, write: boolean) => {
  const { item, access } = await loadItem(db, a, itemId);
  const column = await findColumnByKey(db, item.boardId, columnKey);
  if (!column || columnTypes.get(column.type)?.engine !== 'time') {
    throw new AppError('not_found', 'Time tracking column not found');
  }
  if (!columnAllowed(access, column.restrictedView)) throw new AppError('not_found', 'Column not found');
  if (write) {
    assertBoard(access, 'item.update');
    if (!columnAllowed(access, column.restrictedEdit)) {
      throw new AppError('forbidden', `column_restricted:${column.key}`);
    }
  }
  return { item, access, column, settings: column.settings as TimeSettings };
};

/** Closes a running entry at `now` (in tx) and refreshes its cell. */
const closeEntry = async (tx: Db, a: Actor, entry: NamedEntry['entry'], now: Date) => {
  await updateEntry(tx, entry.id, { endedAt: now });
  const column = await findColumnById(tx, entry.columnId);
  const item = await itemOfEntry(tx, entry.itemId);
  if (column && item) await syncTimeCell(tx, a, item, column);
  await recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'time.stopped',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: entry.boardId,
    itemId: entry.itemId,
    columnId: entry.columnId,
    after: { entry_id: entry.id, duration_s: Math.round((now.getTime() - entry.startedAt.getTime()) / 1000) },
  });
};

/**
 * ▶ — starts my timer on this cell. Timers elsewhere keep running (several at once are allowed, to be filtered
 * later); a second start on the same cell returns the running one.
 */
export const startTimer = async (db: Db, a: Actor, itemId: string, input: { column_id: string; note?: string }) => {
  const { item, column } = await loadTimeColumn(db, a, itemId, input.column_id, true);
  const here = (await runningEntriesOf(db, a.ctx.accountId, a.user.id, item.id)).find(
    (r) => r.entry.columnId === column.id,
  );
  if (here) return dto(here, column.key);
  const id = newId();
  const now = new Date();
  await db.transaction(async (tx) => {
    await insertEntry(tx, {
      id,
      accountId: a.ctx.accountId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      userId: a.user.id,
      startedAt: now,
      source: 'timer',
      note: input.note ?? null,
      billable: (column.settings as TimeSettings).billable_default ?? true,
    });
    await syncTimeCell(tx, a, item, column);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'time.started',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      after: { entry_id: id },
    });
  });
  return dto((await findNamedEntry(db, a.ctx.accountId, id))!, column.key);
};

/** ⏸ — stops my running timer on this item (on one column, or on every column of the item). */
export const stopTimer = async (db: Db, a: Actor, itemId: string, columnKey?: string) => {
  const { item } = await loadItem(db, a, itemId);
  const column = columnKey ? await findColumnByKey(db, item.boardId, columnKey) : null;
  const running = (await runningEntriesOf(db, a.ctx.accountId, a.user.id, itemId)).filter(
    (r) => !column || r.entry.columnId === column.id,
  );
  if (!running.length) throw new AppError('no_running_timer', 'No running timer here');
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const r of running) await closeEntry(tx, a, r.entry, now);
  });
  const first = (await findNamedEntry(db, a.ctx.accountId, running[0]!.entry.id))!;
  return dto(first, await keyOf(db, first.entry.columnId));
};

/** All my running timers in this account (any number). */
export const myRunningTimers = async (db: Db, a: Actor) => {
  const rows = await runningEntriesOf(db, a.ctx.accountId, a.user.id);
  const out = [];
  for (const r of rows) {
    const item = await itemOfEntry(db, r.entry.itemId);
    if (item) {
      out.push({
        entry: dto(r, await keyOf(db, r.entry.columnId)),
        item: { id: item.id, name: item.name, board_id: item.boardId },
      });
    }
  }
  return out;
};

/** The item's time log (every time column), newest first. */
export const listEntries = async (db: Db, a: Actor, itemId: string) => {
  const { item } = await loadItem(db, a, itemId);
  const rows = await listItemEntries(db, item.id);
  const keys = new Map<string, string>();
  for (const r of rows) if (!keys.has(r.entry.columnId)) keys.set(r.entry.columnId, await keyOf(db, r.entry.columnId));
  return rows.map((r) => dto(r, keys.get(r.entry.columnId)!));
};

const assertRange = (start: Date, end: Date) => {
  const problem = validateEntryRange(start, end);
  if (problem) throw new AppError(problem as 'invalid_time', problem);
};

/** "+ add entry" (03 §3.3): start + end or start + duration; for someone else only as board owner / admin. */
export const addEntry = async (db: Db, a: Actor, itemId: string, input: z.infer<typeof addTimeEntrySchema>) => {
  const { item, access, column, settings } = await loadTimeColumn(db, a, itemId, input.column_id, true);
  if (settings.allow_manual === false) throw new AppError('forbidden', 'time_manual_disabled');
  const userId = input.user_id ?? a.user.id;
  if (userId !== a.user.id) {
    const allowed =
      settings.allow_other_users === 'all' || (settings.allow_other_users !== 'none' && isOwnerOrAdmin(access));
    if (!allowed) throw new AppError('forbidden', 'time_other_user');
    if (!(await isAccountMember(db, a.ctx.accountId, [userId]))) throw new AppError('invalid_value', 'Unknown user');
  }
  const start = new Date(input.started_at);
  const end = input.ended_at ? new Date(input.ended_at) : new Date(start.getTime() + input.duration_s! * 1000);
  assertRange(start, end);
  const id = newId();
  await db.transaction(async (tx) => {
    await insertEntry(tx, {
      id,
      accountId: a.ctx.accountId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      userId,
      startedAt: start,
      endedAt: end,
      source: 'manual',
      note: input.note ?? null,
      billable: input.billable ?? settings.billable_default ?? true,
      ...(userId !== a.user.id ? { editedBy: a.user.id, editedAt: new Date() } : {}),
    });
    await syncTimeCell(tx, a, item, column);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'time.entry_added',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      after: { entry_id: id, user_id: userId, started_at: start.toISOString(), ended_at: end.toISOString() },
    });
  });
  return dto((await findNamedEntry(db, a.ctx.accountId, id))!, column.key);
};

/** An entry I may change: mine, or any as board owner / admin. */
const loadOwnEntry = async (db: Db, a: Actor, entryId: string) => {
  const found = await findNamedEntry(db, a.ctx.accountId, entryId);
  if (!found) throw new AppError('not_found', 'Time entry not found');
  const column = await findColumnById(db, found.entry.columnId);
  if (!column) throw new AppError('not_found', 'Time entry not found');
  const { item, access } = await loadTimeColumn(db, a, found.entry.itemId, column.key, true);
  if (found.entry.userId !== a.user.id && !isOwnerOrAdmin(access))
    throw new AppError('forbidden', 'time_entry_owner_only');
  return { found, column, item };
};

export const editEntry = async (db: Db, a: Actor, entryId: string, patch: z.infer<typeof updateTimeEntrySchema>) => {
  const { found, column, item } = await loadOwnEntry(db, a, entryId);
  const e = found.entry;
  const start = patch.started_at ? new Date(patch.started_at) : e.startedAt;
  const end = patch.ended_at ? new Date(patch.ended_at) : e.endedAt;
  if (patch.ended_at && !e.endedAt) throw new AppError('bad_request', 'Stop the timer to set its end');
  if (end) assertRange(start, end);
  // A running timer's start may be moved, but not past now: its elapsed time would go negative (audit A6).
  else if (start.getTime() > Date.now()) throw new AppError('invalid_time', 'start_in_future');
  await db.transaction(async (tx) => {
    await updateEntry(tx, e.id, {
      startedAt: start,
      ...(end ? { endedAt: end } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.billable !== undefined ? { billable: patch.billable } : {}),
      editedBy: a.user.id,
      editedAt: new Date(),
    });
    await syncTimeCell(tx, a, item, column);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'time.entry_edited',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      before: {
        entry_id: e.id,
        started_at: e.startedAt.toISOString(),
        ended_at: e.endedAt?.toISOString() ?? null,
        note: e.note,
        billable: e.billable,
      },
      after: patch,
    });
  });
  return dto((await findNamedEntry(db, a.ctx.accountId, e.id))!, column.key);
};

/** Soft delete (trash, 30 days) — the entry stops counting at once. */
export const deleteEntry = async (db: Db, a: Actor, entryId: string) => {
  const { found, column, item } = await loadOwnEntry(db, a, entryId);
  await db.transaction(async (tx) => {
    await updateEntry(tx, found.entry.id, {
      deletedAt: new Date(),
      ...(found.entry.endedAt ? {} : { endedAt: new Date() }),
    });
    await syncTimeCell(tx, a, item, column);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'time.entry_deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      before: { entry_id: found.entry.id, duration_s: found.entry.durationS },
    });
  });
};
