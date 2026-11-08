// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type BoardAction,
  type BulkItemsRequest,
  columnTypes,
  dayCountOf,
  newId,
  rankBetween,
  shiftSpanCounted,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { accountWorkCalendar } from '../../lib/account-calendar';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, columnAllowed, loadBoardAccess } from '../boards/boards.access';
import { findGroup, listColumns } from '../boards/boards.repo';
import { itemCells, itemsByIds, lastItemPosition, updateItemRow } from './items.repo';
import { type Actor, assertAssigned, deleteItemTx, nameWho, writeCell } from './items.service';
import { collectItemChanges, itemsChanged } from './names.service';
import { archiveItemTx } from '../archive/archive.service';
import { findSubBoard } from '../boards/boards.repo';
import { duplicateItemTx } from './duplicate.service';
import { boardVisibility, filterVisible } from './visibility';
import { moveItemToBoardTx, prepareBulkMove } from './move.service';
import { moveInTreeTx, prepareTreeMove } from './hierarchy.service';
import { assertDeleteCode } from '../boards/delete-guard';

const RIGHT: Record<BulkItemsRequest['action']['type'], BoardAction> = {
  delete: 'item.delete',
  archive: 'item.delete',
  duplicate: 'item.create',
  move_to_board: 'item.move_group',
  move_to_group: 'item.move_group',
  set_cell: 'item.update',
  change_links: 'item.update',
  shift_dates: 'item.update',
  // Hierarchy moves: rows changing board also need `item.create` there (checked by the hierarchy service).
  move_under: 'item.update',
  move_up: 'item.update',
};

type DateCell = { date: string; time?: string };
type TimelineCell = { from: string; to: string; milestone?: boolean };

/**
 * POST /boards/:id/items/bulk (07 §6). One transaction, one `batch_id` on every event plus a `batch.executed`
 * summary — undoing the summary undoes the batch. Items that are gone, on another board, or that the actor
 * may not change (edit_assigned) are skipped and counted; a bad value fails the whole request.
 */
export const bulkItems = async (db: Db, actor: Actor, boardId: string, input: BulkItemsRequest) => {
  // r19relfilter: a fill / paste over many items leaves out links the relation's filter does not offer (counted).
  const a: Actor = { ...actor, relationPolicy: 'drop', notes: [] };
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  const { action } = input;
  assertBoard(access, RIGHT[action.type]);
  // a board that asks for a code before deleting asks once for the whole batch.
  if (action.type === 'delete' || action.type === 'archive') await assertDeleteCode(db, a, access.board);

  const ids = [...new Set(input.item_ids)];
  const found = await filterVisible(
    db,
    await boardVisibility(db, a, access),
    (await itemsByIds(db, a.ctx.accountId, ids)).filter((i) => i.boardId === boardId),
  );
  const order = new Map(ids.map((id, i) => [id, i]));
  found.sort((x, y) => order.get(x.id)! - order.get(y.id)!);
  const columns = await listColumns(db, boardId);

  const byColumn = action.type === 'set_cell' || action.type === 'shift_dates' || action.type === 'change_links';
  const column = byColumn
    ? // A hidden column (05 §6.1 `view`) is not found, before any item is looked at (audit 2026-10-10 #1).
      columns.find((c) => c.key === action.column_id && columnAllowed(access, c.restrictedView))
    : undefined;
  if (byColumn && !column) throw new AppError('not_found', 'Column not found');
  if (action.type === 'change_links' && columnTypes.get(column!.type)?.engine !== 'links') {
    throw new AppError('invalid_value', 'Only relation columns change links', { column_id: column!.key });
  }
  if (action.type === 'shift_dates' && column!.type !== 'date' && column!.type !== 'timeline') {
    throw new AppError('invalid_value', 'Only date and timeline columns shift', { column_id: column!.key });
  }
  // "Shift dates by N days" counts days as the column does (its duration, else the account's).
  const count =
    action.type === 'shift_dates'
      ? await accountWorkCalendar(db, a.ctx.accountId).then((w) =>
          dayCountOf(column!.settings as { duration?: string; keep_workdays?: boolean }, w.calendar, w.weekend),
        )
      : undefined;
  const group = action.type === 'move_to_group' ? await findGroup(db, boardId, action.group_id) : undefined;
  if (action.type === 'move_to_group' && !group) throw new AppError('not_found', 'Group not found');

  const move = action.type === 'move_to_board' ? await prepareBulkMove(db, a, boardId, action) : undefined;
  const tree =
    action.type === 'move_under' || action.type === 'move_up'
      ? await prepareTreeMove(db, a, access, action, found)
      : undefined;
  const subBoardId = access.board.parentBoardId ? null : ((await findSubBoard(db, boardId))?.id ?? null);
  const batchId = newId();
  return db.transaction(async (tx) => {
    let done = 0;
    let skipped = ids.length - found.length;
    let lastPosition = group ? await lastItemPosition(tx, group.id) : null;

    // Computed names: one recompute for the whole batch, at the end.
    const [, changed] = await collectItemChanges(tx, async () => {
      for (const item of found) {
        const cells = await itemCells(tx, item.id);
        try {
          assertAssigned(access, a.user, item, cells, columns);
        } catch {
          skipped++;
          continue;
        }
        switch (action.type) {
          case 'delete':
            await deleteItemTx(tx, a, item, batchId);
            break;
          case 'duplicate':
            await duplicateItemTx(tx, a, item, { withUpdates: false, batchId, subBoardId });
            break;
          case 'move_to_board':
            if (item.depth > 0) {
              skipped++;
              continue;
            }
            await moveItemToBoardTx(tx, a, item, move!.target, move!.groupId, move!.mapping, batchId);
            break;
          case 'archive':
            if (item.archivedAt) break;
            await archiveItemTx(tx, a, item, batchId);
            break;
          case 'move_to_group': {
            if (item.depth > 0) {
              skipped++;
              continue;
            }
            if (item.groupId === group!.id) break;
            const position = rankBetween(lastPosition, null);
            lastPosition = position;
            await updateItemRow(tx, item.id, { groupId: group!.id, position });
            await recordEvent(tx, {
              accountId: a.ctx.accountId,
              type: 'item.moved_to_group',
              actorId: a.user.id,
              requestId: a.requestId,
              boardId,
              itemId: item.id,
              batchId,
              before: { group_id: item.groupId, position: item.position },
              after: { group_id: group!.id, position },
            });
            break;
          }
          case 'move_under':
          case 'move_up': {
            // A row whose checked ancestor carries it counts as done; one already there (or an item for
            // "up") is skipped. Structural refusals (cycle, too deep) fail the whole batch.
            const out = await moveInTreeTx(tx, a, tree!, item, batchId);
            if (out.kind === 'skipped') {
              skipped++;
              continue;
            }
            break;
          }
          case 'set_cell':
            try {
              const meta = action.workflow_override ? { workflow_override: true } : {};
              await writeCell(tx, a, access, item, column!, action.value ?? null, batchId, meta);
            } catch (e) {
              // the workflow check runs before anything is written, so the item is just skipped.
              if (e instanceof AppError && e.code === 'workflow_blocked') {
                skipped++;
                continue;
              }
              throw e;
            }
            break;
          case 'change_links': {
            // Each item keeps its own links: the added ones join (a single-link column: replace), the removed go.
            const current =
              (cells.find((c) => c.columnId === column!.id)?.value as { item_ids?: string[] } | null)?.item_ids ?? [];
            const single = column!.settings.allow_multiple === false;
            const kept = current.filter((id) => !action.remove.includes(id));
            const next = single && action.add.length ? [action.add[0]!] : [...new Set([...kept, ...action.add])];
            if (next.length === current.length && next.every((id, i) => id === current[i])) break;
            await writeCell(tx, a, access, item, column!, next.length ? { item_ids: next } : null, batchId);
            break;
          }
          case 'shift_dates': {
            const current = cells.find((c) => c.columnId === column!.id)?.value as DateCell | TimelineCell | undefined;
            if (!current) break; // nothing to shift
            const day = (current as DateCell).date;
            const next =
              column!.type === 'date'
                ? { ...(current as DateCell), date: shiftSpanCounted({ from: day, to: day }, action.days, count).from }
                : {
                    ...(current as TimelineCell),
                    ...shiftSpanCounted(
                      { from: (current as TimelineCell).from, to: (current as TimelineCell).to },
                      action.days,
                      count,
                    ),
                  };
            await writeCell(tx, a, access, item, column!, next, batchId);
            break;
          }
        }
        done++;
      }
    });
    await itemsChanged(tx, nameWho(a), changed);

    const eventId = await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'batch.executed',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      batchId,
      meta: { action: action.type, count: done, skipped },
    });
    const dropped = (a.notes ?? []).reduce((n, x) => n + x.ids.length, 0);
    return {
      ok: true as const,
      batch_id: batchId,
      event_id: eventId,
      done,
      skipped,
      ...(dropped ? { links_dropped: dropped } : {}),
    };
  });
};
