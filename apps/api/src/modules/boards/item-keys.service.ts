// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, ITEM_KEY_PREFIX_RE, newId, type ItemSequence } from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, loadBoardAccess } from './boards.access';
import { findColumnByKey } from './boards.repo';
import {
  insertItemKeyRow,
  itemKeyOfBoard,
  type ItemKeyRow,
  maxKeySeq,
  numberUnkeyedItems,
  prefixUsedElsewhere,
  updateItemKeyRow,
} from './item-keys.repo';

const sequenceDto = (row: ItemKeyRow, max: number | null): ItemSequence => ({
  prefix: row.prefix,
  padding: row.padding,
  next_seq: row.nextSeq,
  max_seq: max,
});

/**
 * Makes sure a board numbers its items for an item_id column (03 §2.19) — the API / UI path, templates, board
 * copies and importers alike. Idempotent:
 * - no sequence yet: one is created; the next number is above the board's highest number (1 on a new board);
 * - a sequence: it is taken over by this column with the given prefix and padding (numbers are kept).
 * `backfill` (default on): items without a number get one, in creation order. An importer that writes
 * `items.key_seq` itself passes `backfill: false` and then calls `setNextItemKeySeq`.
 * A non-empty prefix used by another board of the account → 409 (an empty prefix = just the number, anywhere).
 */
export const ensureItemKeySequence = async (
  tx: Db,
  p: { accountId: string; boardId: string; columnId: string; prefix?: string; padding?: number; backfill?: boolean },
): Promise<ItemSequence> => {
  const prefix = p.prefix ?? '';
  if (!ITEM_KEY_PREFIX_RE.test(prefix)) {
    throw new AppError('validation_failed', 'Invalid item number prefix', { prefix });
  }
  const padding = Math.min(8, Math.max(1, Math.trunc(p.padding ?? 1)));
  if (await prefixUsedElsewhere(tx, p.accountId, prefix, p.boardId)) {
    throw new AppError('conflict', 'item_key_prefix_taken', { prefix });
  }
  let row = await itemKeyOfBoard(tx, p.boardId);
  if (!row) {
    const id = newId();
    await insertItemKeyRow(tx, {
      id,
      accountId: p.accountId,
      boardId: p.boardId,
      columnId: p.columnId,
      prefix,
      padding,
      nextSeq: ((await maxKeySeq(tx, p.boardId)) ?? 0) + 1,
    });
    row = (await itemKeyOfBoard(tx, p.boardId))!;
  } else if (row.columnId !== p.columnId || row.prefix !== prefix || row.padding !== padding) {
    await updateItemKeyRow(tx, row.id, { columnId: p.columnId, prefix, padding });
    row = { ...row, columnId: p.columnId, prefix, padding };
  }
  if (p.backfill !== false) {
    const n = await numberUnkeyedItems(tx, p.boardId, row.nextSeq);
    if (n) {
      await updateItemKeyRow(tx, row.id, { nextSeq: row.nextSeq + n });
      row = { ...row, nextSeq: row.nextSeq + n };
    }
  }
  return sequenceDto(row, await maxKeySeq(tx, p.boardId));
};

/** An item_id column created or re-set (API / UI): `custom_key` numbers the board's items. */
export const syncItemIdColumn = async (
  tx: Db,
  p: { accountId: string; boardId: string; columnId: string; settings: Record<string, unknown> },
) => {
  if (p.settings.display !== 'custom_key') return;
  const prefix = typeof p.settings.prefix === 'string' ? p.settings.prefix : '';
  const padding = typeof p.settings.padding === 'number' ? p.settings.padding : prefix ? 4 : 1;
  await ensureItemKeySequence(tx, {
    accountId: p.accountId,
    boardId: p.boardId,
    columnId: p.columnId,
    prefix,
    padding,
  });
};

/**
 * The number the board's next item gets (continue numbering from an old system). It must be above every number
 * already given on the board (numbers are never reused).
 */
export const setNextItemKeySeq = async (tx: Db, p: { boardId: string; next: number }): Promise<ItemSequence> => {
  const row = await itemKeyOfBoard(tx, p.boardId);
  if (!row) throw new AppError('not_found', 'The board does not number its items');
  const max = await maxKeySeq(tx, p.boardId);
  if (!Number.isInteger(p.next) || p.next < 1 || (max !== null && p.next <= max)) {
    throw new AppError('validation_failed', 'next_seq_too_low', { next_seq: p.next, max_seq: max });
  }
  await updateItemKeyRow(tx, row.id, { nextSeq: p.next });
  return sequenceDto({ ...row, nextSeq: p.next }, max);
};

const itemIdColumn = async (db: Db, boardId: string, key: string) => {
  const column = await findColumnByKey(db, boardId, key);
  if (!column || column.type !== 'item_id') throw new AppError('not_found', 'Column not found');
  return column;
};

/** GET /boards/:id/columns/:key/sequence — the board's numbering (null: it has none). */
export const getItemSequence = async (db: Db, a: Actor, boardId: string, key: string) => {
  await loadBoardAccess(db, a.ctx, a.user, boardId);
  await itemIdColumn(db, boardId, key);
  const row = await itemKeyOfBoard(db, boardId);
  return { sequence: row ? sequenceDto(row, await maxKeySeq(db, boardId)) : null };
};

/** PUT /boards/:id/columns/:key/sequence — the next number (column settings rights). */
export const updateItemSequence = async (db: Db, a: Actor, boardId: string, key: string, next: number) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'column.update');
  const column = await itemIdColumn(db, boardId, key);
  return db.transaction(async (tx) => {
    const before = await itemKeyOfBoard(tx, boardId);
    const sequence = await setNextItemKeySeq(tx, { boardId, next });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'column.settings_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      columnId: column.id,
      before: { next_seq: before?.nextSeq ?? null },
      after: { next_seq: sequence.next_seq },
    });
    return { sequence };
  });
};
