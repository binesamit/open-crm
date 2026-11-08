// SPDX-License-Identifier: AGPL-3.0-only
import { followNewItem } from '../notifications/notifications.service';
import {
  accountDefaultsOf,
  AppError,
  columnTypes,
  type createSubitemSchema,
  effectiveDepthMax,
  newId,
  rankBetween,
  type positionSchema,
  type reorderSubitemSchema,
  statusLabelsFromDefaults,
  withNewColumnDefaults,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import { getAccountSettings } from '../accounts/accounts.repo';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, type BoardAccess, loadBoardAccess, positionAmong } from '../boards/boards.access';
import { type BoardRow, findBoard, findSubBoard, insertBoard, insertColumns, listColumns } from '../boards/boards.repo';
import { childItemsOf, findItem, insertItem, itemCells, type ItemRow, updateItemRow } from './items.repo';
import { descendantsOf, placeItem, snapshotItem } from './move.repo';
import { type Actor, assertAssigned, freshItem, loadItem, nameWho, writeCell } from './items.service';
import { collectItemChanges, initialItemName, itemsChanged } from './names.service';
import { accountLocale, st } from '../../lib/i18n';

/**
 * Columns a new sub-board starts with (D14): name, owner, status, date. Their titles are
 * i18n keys, written in the account's language (ANSWERS 6א.4); each is renamed like any column afterwards.
 */
const SUB_COLUMNS: { key: string; type: string; title: string; width: number }[] = [
  { key: 'name', type: 'name', title: 'server.subitem.name', width: 240 },
  { key: 'person', type: 'people', title: 'server.subitem.owner', width: 140 },
  { key: 'status', type: 'status', title: 'server.subitem.status', width: 140 },
  { key: 'date', type: 'date', title: 'server.subitem.date', width: 140 },
];

/** The board's sub-board, created on first use with its default columns (subitems have no group). */
export const ensureSubBoard = async (tx: Db, a: Actor, parent: BoardRow) => {
  const existing = await findSubBoard(tx, parent.id);
  if (existing) return existing;
  const id = newId();
  const lang = await accountLocale(tx, a.ctx.accountId);
  await insertBoard(tx, {
    id,
    accountId: a.ctx.accountId,
    workspaceId: parent.workspaceId,
    folderId: null,
    parentBoardId: parent.id,
    name: st('server.subitemsBoard', { board: parent.name }, lang).slice(0, 255),
    kind: parent.kind,
    position: rankBetween(null, null),
    hierarchyDepthMax: parent.hierarchyDepthMax,
    createdBy: a.user.id,
  });
  // The status column starts with the account's default labels (A3), like any new status column.
  const defaults = accountDefaultsOf(await getAccountSettings(tx, a.ctx.accountId));
  const initialSettings = (type: string) =>
    type === 'status'
      ? { labels: statusLabelsFromDefaults(defaults.status_labels) }
      : columnTypes.has(type)
        ? withNewColumnDefaults(columnTypes.get(type)!, undefined, defaults)
        : {};
  let prev: string | null = null;
  await insertColumns(
    tx,
    SUB_COLUMNS.map((c) => {
      prev = rankBetween(prev, null);
      return {
        id: newId(),
        accountId: a.ctx.accountId,
        boardId: id,
        key: c.key,
        type: c.type,
        title: st(c.title, undefined, lang),
        position: prev,
        width: c.width,
        settings: initialSettings(c.type) as Record<string, unknown>,
        createdBy: a.user.id,
      };
    }),
  );
  await recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'board.subitems_created',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: parent.id,
    after: { sub_board_id: id },
  });
  return (await findBoard(tx, a.ctx.accountId, id))!;
};

/**
 * POST /items/:id/subitems (D14). A subitem of an item lives on that board's sub-board; a subitem of a subitem
 * stays on the same sub-board, one level deeper (up to the board's `hierarchy_depth_max`).
 */
export const createSubitem = async (
  db: Db,
  a: Actor,
  parentItemId: string,
  input: z.infer<typeof createSubitemSchema>,
) => {
  const { item: parent, access } = await loadItem(db, a, parentItemId);
  const { id, subBoardId } = await db.transaction((tx) => createSubitemTx(tx, a, access, parent, input));
  return freshItem(db, a, await loadBoardAccess(db, a.ctx, a.user, subBoardId), id);
};

/**
 * A subitem of `parent` inside the caller's transaction — `createSubitem`, and a popup's new subitems
 * which pass their write's `batchId` so the whole popup is one Ctrl+Z.
 */
export const createSubitemTx = async (
  tx: Db,
  a: Actor,
  access: BoardAccess,
  parent: ItemRow,
  input: Pick<z.infer<typeof createSubitemSchema>, 'name' | 'cells' | 'position'>,
  batch?: string,
  /** Where it came from (`popup`): its creation then undoes with the batch. */
  via?: string,
) => {
  assertBoard(access, 'item.create');
  const root = access.board.parentBoardId
    ? await findBoard(tx, a.ctx.accountId, access.board.parentBoardId)
    : access.board;
  if (!root) throw new AppError('not_found', 'Board not found');
  const depth = parent.depth + 1;
  // `hierarchy_depth_max` = the deepest subitem depth (2 = sub-subitems, as every new board; audit 2026-10-10
  // C4), never past the items CHECK (`effectiveDepthMax`).
  const depthMax = effectiveDepthMax(root.hierarchyDepthMax);
  if (depth > depthMax) {
    throw new AppError('depth_exceeded', `This board allows ${depthMax} levels of subitems`);
  }

  const id = newId();
  const sub = access.board.parentBoardId ? access.board : await ensureSubBoard(tx, a, root);
  const subAccess = await loadBoardAccess(tx, a.ctx, a.user, sub.id);
  const columns = await listColumns(tx, sub.id);
  // The sub-board's own name source: a computed one ignores a given name.
  const initial = initialItemName(columns, input.name);
  const cellEntries = Object.entries(input.cells ?? {});
  const targets = cellEntries.map(([k]) => {
    const col = columns.find((c) => c.key === k);
    if (!col) throw new AppError('not_found', `Column "${k}" not found`);
    return col;
  });
  const batchId = batch ?? (cellEntries.length ? newId() : null);
  await insertItem(tx, {
    id,
    accountId: a.ctx.accountId,
    boardId: sub.id,
    groupId: null, // ck_items_tree: subitems hang on their parent, not on a group
    parentItemId: parent.id,
    rootItemId: parent.rootItemId ?? parent.id,
    depth,
    position: positionAmong(await childItemsOf(tx, [parent.id]), input.position),
    name: initial.name,
    createdBy: a.user.id,
    creatorType: a.automation ? 'automation' : 'user',
  });
  const createdEvent = await recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'item.created',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: sub.id,
    itemId: id,
    batchId,
    after: { name: initial.name, parent_item_id: parent.id },
    ...(via ? { meta: { via } } : {}),
  });
  await followNewItem(tx, a, id);
  const item = (await findItem(tx, a.ctx.accountId, id))!;
  const [, changed] = await collectItemChanges(tx, async () => {
    for (const [i, [, value]] of cellEntries.entries()) {
      await writeCell(tx, a, subAccess, item, targets[i]!, value, batchId);
    }
  });
  // Its computed name, and the parent's (a name over its subitems) follow.
  await itemsChanged(tx, nameWho(a), [id, parent.id, ...changed], { silent: new Map([[id, createdEvent]]) });
  return { id, subBoardId: sub.id };
};

/**
 * POST /items/:id/reorder — a subitem among its siblings (they have no group; items move with move-to-group).
 * Recorded as `item.reordered`, undone back to the old position.
 */
export const reorderSubitem = async (db: Db, a: Actor, itemId: string, input: z.infer<typeof reorderSubitemSchema>) => {
  const { item, access } = await loadItem(db, a, itemId);
  assertBoard(access, 'item.move_group');
  if (!item.parentItemId) throw new AppError('bad_request', 'not_a_subitem');
  assertAssigned(access, a.user, item, await itemCells(db, item.id), await listColumns(db, item.boardId));
  const siblings = (await childItemsOf(db, [item.parentItemId])).filter((s) => s.id !== item.id);
  const position = positionAmong(siblings, input.position);
  const eventId = await db.transaction(async (tx) => {
    await updateItemRow(tx, item.id, { position });
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'item.reordered',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      before: { group_id: null, position: item.position },
      after: { group_id: null, position },
    });
  });
  // The reorder's event: Ctrl+Z can undo a drag among siblings (Fix: ).
  return { ...(await freshItem(db, a, access, item.id)), event_id: eventId };
};

/**
 * POST /items/:id/reparent (fix6-table 5) — drag a subitem to another parent: under another item of the same
 * board, or under another subitem (one level deeper), at `position` among its new siblings (default: last). Its
 * own subitems come along, re-levelled. Same sub-board, so the cells stay. Needs `item.update`; never under
 * itself or its own subitems; the board's `hierarchy_depth_max` holds for the whole moved branch.
 * Recorded as `item.converted` events of one batch (the snapshots) — undone back in one go.
 */
export const reparentSubitem = async (
  db: Db,
  a: Actor,
  itemId: string,
  input: { parent_item_id: string; position?: z.infer<typeof positionSchema> },
) => {
  const { item, access } = await loadItem(db, a, itemId);
  assertBoard(access, 'item.update');
  if (!item.parentItemId || !access.board.parentBoardId) throw new AppError('bad_request', 'not_a_subitem');
  assertAssigned(access, a.user, item, await itemCells(db, item.id), await listColumns(db, item.boardId));
  // The new parent: visible to the actor (404 otherwise), an item of the same board or a subitem beside this one.
  const { item: parent } = await loadItem(db, a, input.parent_item_id);
  if (parent.boardId !== access.board.id && parent.boardId !== access.board.parentBoardId) {
    throw new AppError('bad_request', 'bad_parent');
  }
  const root = await findBoard(db, a.ctx.accountId, access.board.parentBoardId);
  if (!root) throw new AppError('not_found', 'Board not found');
  const eventId = await db.transaction((tx) =>
    reparentTx(tx, a, item, parent, root.hierarchyDepthMax, newId(), input.position ?? 'bottom'),
  );
  return { ok: true as const, event_id: eventId, dropped: 0 };
};

/**
 * The move of `reparentSubitem` inside the caller's transaction (also a bulk edit's, B4): `item` (a subitem) and its
 * own subitems under `parent`, re-levelled, at `position` among the new siblings. Never under itself or its own
 * subitems; `depthMax` holds for the whole branch. One `item.converted` event per moved item, all with `batchId`.
 * Returns the moved item's event id.
 */
export const reparentTx = async (
  tx: Db,
  a: Actor,
  item: ItemRow,
  parent: ItemRow,
  depthMax: number,
  batchId: string,
  position: z.infer<typeof positionSchema> = 'bottom',
) => {
  const descendants = await descendantsOf(tx, item.id);
  if (parent.id === item.id || descendants.some((d) => d.id === parent.id)) {
    throw new AppError('bad_request', 'tree_cycle');
  }
  const depth = parent.depth + 1;
  const deepest = Math.max(0, ...descendants.map((d) => d.depth - item.depth));
  const max = effectiveDepthMax(depthMax);
  if (depth + deepest > max) throw new AppError('depth_exceeded', 'tree_too_deep', { max });
  const siblings = (await childItemsOf(tx, [parent.id])).filter((s) => s.id !== item.id);
  const at = positionAmong(siblings, position);
  const rootItemId = parent.rootItemId ?? parent.id;
  const move = async (row: ItemRow, target: { parentItemId: string | null; depth: number; position: string }) => {
    const before = await snapshotItem(tx, row.id);
    await placeItem(tx, row.id, {
      board_id: row.boardId,
      group_id: null,
      parent_item_id: target.parentItemId,
      root_item_id: rootItemId,
      depth: target.depth,
      position: target.position,
    });
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'item.converted',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: row.boardId,
      itemId: row.id,
      batchId,
      before,
      after: {
        board_id: row.boardId,
        group_id: null,
        parent_item_id: target.parentItemId,
        depth: target.depth,
      },
      meta: { from_board_id: row.boardId, reparent: true, dropped: 0 },
    });
  };
  const top = await move(item, { parentItemId: parent.id, depth, position: at });
  for (const d of descendants) {
    await move(d, { parentItemId: d.parentItemId, depth: depth + (d.depth - item.depth), position: d.position });
  }
  return top;
};
