// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, columnTypes, deriveValues } from '@bines/shared';
import type { Db } from '../../db/client';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, columnAllowed } from '../boards/boards.access';
import { findColumnByKey, listColumns } from '../boards/boards.repo';
import { type Actor, assertAssigned, freshItem, loadItem } from './items.service';
import { deleteCell, itemCells, updateItemRow, upsertCell } from './items.repo';

/**
 * My vote on a vote column (03 §3.11): one per user; `vote: true` casts it, `false` takes it back. The cell
 * (`{voter_ids}`) is written only here — PUT /cells refuses the column (engine 'vote').
 */
export const setVote = async (db: Db, a: Actor, itemId: string, columnKey: string, vote: boolean) => {
  const { item, access } = await loadItem(db, a, itemId);
  const column = await findColumnByKey(db, item.boardId, columnKey);
  const def = column ? columnTypes.get(column.type) : undefined;
  if (!column || def?.engine !== 'vote' || !columnAllowed(access, column.restrictedView)) {
    throw new AppError('not_found', 'Vote column not found');
  }
  assertBoard(access, 'item.update');
  if (!columnAllowed(access, column.restrictedEdit)) throw new AppError('forbidden', `column_restricted:${column.key}`);
  const cells = await itemCells(db, item.id);
  assertAssigned(access, a.user, item, cells, await listColumns(db, item.boardId));

  const before = (cells.find((c) => c.columnId === column.id)?.value as { voter_ids?: string[] } | undefined) ?? null;
  const voters = before?.voter_ids ?? [];
  if (voters.includes(a.user.id) === vote) return { ...(await freshItem(db, a, access, item.id)), event_id: null };
  const next = vote ? [...voters, a.user.id] : voters.filter((id) => id !== a.user.id);

  await db.transaction(async (tx) => {
    if (next.length) {
      const value = { voter_ids: next };
      const d = deriveValues(def, column.settings, value);
      await upsertCell(tx, {
        itemId: item.id,
        columnId: column.id,
        accountId: a.ctx.accountId,
        boardId: item.boardId,
        value,
        textValue: d.textValue,
        numberValue: d.numberValue,
        dateValue: null,
        dateEndValue: null,
        updatedBy: a.user.id,
        updatedByType: 'user',
      });
    } else await deleteCell(tx, item.id, column.id);
    await updateItemRow(tx, item.id, { lastCellChangeAt: new Date(), lastCellChangeBy: a.user.id });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: vote ? 'vote.cast' : 'vote.removed',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      before: { value: before },
      after: { value: next.length ? { voter_ids: next } : null },
      meta: { column_key: column.key, column_type: column.type },
    });
  });
  // Not undoable (vote again instead) — no event id for Ctrl+Z.
  return { ...(await freshItem(db, a, access, item.id)), event_id: null };
};
