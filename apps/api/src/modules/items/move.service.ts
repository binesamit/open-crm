// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type ColumnMapping,
  columnTypes,
  CONVERTIBLE,
  convertCellValue,
  effectiveDepthMax,
  newId,
  parseCellValue,
  proposeMapping,
  rankBetween,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, type BoardAccess, columnAllowed, loadBoardAccess } from '../boards/boards.access';
import {
  type BoardRow,
  type ColumnRow,
  findSubBoard,
  listColumns,
  listGroups,
  updateGroupRow,
  columnsByBoardIds,
  itemKeyFormat,
  nextItemKeySeq,
} from '../boards/boards.repo';
import { positionAmong } from '../boards/boards.access';
import {
  activeItemsOfGroupRows,
  findItem,
  itemCells,
  type ItemRow,
  lastChildPosition,
  lastItemPosition,
  upsertCell,
} from './items.repo';
import { type Actor, assertAssigned, loadItem, nameWho } from './items.service';
import { noteItemsChanged } from './names.service';
import {
  descendantsOf,
  dropCell,
  moveCell,
  moveLinks,
  moveTimeEntries,
  moveUpdates,
  placeItem,
  snapshotItem,
} from './move.repo';
import { ensureSubBoard } from './subitems.service';
import { reflectItemLinks } from './relations.service';

/**
 * Moving items between boards (07 §3.4–3.5) and item ↔ subitem (§3.7). The row keeps its id (links, URLs and
 * the activity history follow it); cells go to the mapped columns and the rest is dropped — the event keeps
 * the full snapshot, so undo restores the item exactly as it was.
 */
type Target = {
  boardId: string;
  groupId: string | null;
  parentItemId: string | null;
  rootItemId: string | null;
  depth: number;
  position: string;
};

/** `mapping` by column key (what the client sees) → internal column ids; the same type, or a convertible one. */
const LABEL_TYPES = new Set(['status', 'dropdown']);

/**
 * The actor's column restrictions on both sides of a move (05 §6.1, audit 2026-10-10 #3): `hidden` source columns
 * (`view`) are never carried over — their values are dropped like any unmapped column; `locked` target columns
 * (`view` or `edit`) are never written.
 */
type ColumnGuard = { hidden: Set<string>; locked: Set<string> };

const columnGuard = async (
  db: Db,
  a: Actor,
  from: ColumnRow[],
  to: ColumnRow[],
  fromBoardId: string,
  toBoardId: string,
) => {
  const [fromAccess, toAccess] = await Promise.all([
    loadBoardAccess(db, a.ctx, a.user, fromBoardId),
    loadBoardAccess(db, a.ctx, a.user, toBoardId),
  ]);
  return {
    hidden: new Set(from.filter((c) => !columnAllowed(fromAccess, c.restrictedView)).map((c) => c.id)),
    locked: new Set(
      to
        .filter((c) => !columnAllowed(toAccess, c.restrictedView) || !columnAllowed(toAccess, c.restrictedEdit))
        .map((c) => c.id),
    ),
  } satisfies ColumnGuard;
};

const resolveMapping = (mapping: ColumnMapping, from: ColumnRow[], to: ColumnRow[], guard: ColumnGuard) => {
  const out = new Map<string, string | null>();
  for (const [fromKey, toKey] of Object.entries(mapping)) {
    const source = from.find((c) => c.key === fromKey && !guard.hidden.has(c.id));
    if (!source) continue;
    const target = toKey ? to.find((c) => c.key === toKey) : undefined;
    if (target && guard.locked.has(target.id)) throw new AppError('forbidden', `column_restricted:${target.key}`);
    if (
      toKey &&
      (!target || (target.type !== source.type && !(CONVERTIBLE[source.type] ?? []).includes(target.type)))
    ) {
      throw new AppError('invalid_value', 'This column cannot go to a column of that type', { column_id: fromKey });
    }
    out.set(source.id, target?.id ?? null);
  }
  return out;
};

/** The user's mapping, or — when none was sent — the automatic one; within the actor's column restrictions. */
const mappingFor = async (
  db: Db,
  a: Actor,
  mapping: ColumnMapping | undefined,
  fromBoardId: string,
  toBoardId: string,
) => {
  const [from, to] = [await listColumns(db, fromBoardId), await listColumns(db, toBoardId)];
  const guard = await columnGuard(db, a, from, to, fromBoardId, toBoardId);
  return mapping ? resolveMapping(mapping, from, to, guard) : autoMapping(from, to, guard);
};

/** The user's mapping between two boards' columns, within the actor's column restrictions (batch / group moves). */
const guardedMapping = async (db: Db, a: Actor, mapping: ColumnMapping, fromBoardId: string, toBoardId: string) => {
  const [from, to] = [await listColumns(db, fromBoardId), await listColumns(db, toBoardId)];
  return resolveMapping(mapping, from, to, await columnGuard(db, a, from, to, fromBoardId, toBoardId));
};

/**
 * The automatic mapping between two boards' columns (subitems moving along with their parent). Hidden source
 * columns and locked target columns are left out of it (dropped, never an error).
 */
const autoMapping = (from: ColumnRow[], to: ColumnRow[], guard: ColumnGuard) => {
  const source = from.filter((c) => !guard.hidden.has(c.id));
  const target = to.filter((c) => !guard.locked.has(c.id));
  return resolveMapping(
    proposeMapping(
      source.map((c) => ({ id: c.key, type: c.type, title: c.title })),
      target.map((c) => ({ id: c.key, type: c.type, title: c.title })),
    ),
    source,
    target,
    guard,
  );
};

/** Rewrites one item onto `target` with `mapping` (internal column ids); returns how many values were dropped. */
const relocate = async (tx: Db, item: ItemRow, target: Target, mapping: Map<string, string | null>) => {
  const same = item.boardId === target.boardId;
  // Item numbers are per board (03 §2.19): on another board the item gets that board's next number, or none.
  const keySeq = same
    ? undefined
    : (await itemKeyFormat(tx, target.boardId))
      ? Number((await nextItemKeySeq(tx, target.boardId))!.seq)
      : null;
  await placeItem(tx, item.id, {
    board_id: target.boardId,
    group_id: target.groupId,
    parent_item_id: target.parentItemId,
    root_item_id: target.rootItemId,
    depth: target.depth,
    position: target.position,
    key_seq: keySeq,
  });
  if (same) return 0;
  let dropped = 0;
  const columns = new Map((await columnsByBoardIds(tx, [item.boardId, target.boardId])).map((c) => [c.id, c]));
  for (const cell of await itemCells(tx, item.id)) {
    const to = mapping.get(cell.columnId) ?? null;
    const src = columns.get(cell.columnId);
    const dst = to ? columns.get(to) : undefined;
    // Another type, or labels (their ids are the board's): the value is converted (04 §6.2), else moved as is.
    if (to && src && dst && (src.type !== dst.type || LABEL_TYPES.has(src.type))) {
      const value = convertCellValue(
        { type: src.type, value: cell.value, text: cell.textValue ?? '' },
        { type: dst.type, settings: dst.settings },
      );
      const def = columnTypes.get(dst.type);
      const parsed = value === undefined || !def ? null : parseCellValue(def, dst.settings, value);
      await dropCell(tx, item.id, cell.columnId);
      if (parsed?.ok) {
        await upsertCell(tx, {
          itemId: item.id,
          columnId: to,
          accountId: cell.accountId,
          boardId: target.boardId,
          value: parsed.value as Record<string, unknown>,
          textValue: parsed.derived.textValue,
          numberValue: parsed.derived.numberValue,
          dateValue: parsed.derived.dateValue,
          dateEndValue: parsed.derived.dateEndValue,
          updatedBy: cell.updatedBy,
          updatedByType: cell.updatedByType,
        });
      } else dropped++;
    } else if (to) await moveCell(tx, cell, to, target.boardId);
    else {
      await dropCell(tx, item.id, cell.columnId);
      dropped++;
    }
  }
  const snapshot = await snapshotItem(tx, item.id);
  for (const columnId of new Set(snapshot.links.map((l) => l.columnId))) {
    await moveLinks(tx, item.id, columnId, mapping.get(columnId) ?? null);
  }
  for (const te of snapshot.time) {
    const to = mapping.get(te.column_id);
    if (to) await moveTimeEntries(tx, item.id, te.column_id, to, target.boardId);
  }
  await moveUpdates(tx, item.id, target.boardId);
  return dropped;
};

/** One item (+ snapshot event) inside a batch; `type` is the event type. */
const relocateWithEvent = async (
  tx: Db,
  a: Actor,
  item: ItemRow,
  target: Target,
  mapping: Map<string, string | null>,
  type: 'item.moved_to_board' | 'item.converted',
  batchId: string,
) => {
  const before = await snapshotItem(tx, item.id);
  // Two-way columns (03 §2.16): the partners of the old columns lose the item, those of the new ones gain it.
  const dropped = await reflectItemLinks(
    tx,
    { accountId: a.ctx.accountId, itemId: item.id, actorId: a.user.id, requestId: a.requestId },
    () => relocate(tx, item, target, mapping),
  );
  const eventId = await recordEvent(tx, {
    accountId: a.ctx.accountId,
    type,
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: target.boardId,
    itemId: item.id,
    batchId,
    before,
    after: {
      board_id: target.boardId,
      group_id: target.groupId,
      parent_item_id: target.parentItemId,
      depth: target.depth,
    },
    meta: { from_board_id: item.boardId, dropped },
  });
  return { eventId, dropped };
};

/** Subitems of a moved item follow it to the target board's sub-board, auto-mapped (07 §3.4). */
const moveDescendants = async (tx: Db, a: Actor, item: ItemRow, targetRoot: BoardRow, batchId: string) => {
  const children = await descendantsOf(tx, item.id);
  if (!children.length) return 0;
  const fromSub = children[0]!.boardId;
  const toBoard = (await findSubBoard(tx, targetRoot.id)) ?? (await ensureSubBoard(tx, a, targetRoot));
  const [from, to] = [await listColumns(tx, fromSub), await listColumns(tx, toBoard.id)];
  const mapping = autoMapping(from, to, await columnGuard(tx, a, from, to, fromSub, toBoard.id));
  let dropped = 0;
  for (const child of children) {
    dropped += (
      await relocateWithEvent(
        tx,
        a,
        child,
        {
          boardId: toBoard.id,
          groupId: null,
          parentItemId: child.parentItemId,
          rootItemId: item.id,
          depth: child.depth,
          position: child.position,
        },
        mapping,
        'item.moved_to_board',
        batchId,
      )
    ).dropped;
  }
  return dropped;
};

/** The target board of a move: readable, not a sub-board, not the source, and the actor may add items there. */
const targetAccess = async (db: Db, a: Actor, boardId: string, sourceBoardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  if (access.board.parentBoardId || access.board.id === sourceBoardId) throw new AppError('bad_request', 'bad_target');
  assertBoard(access, 'item.create');
  return access;
};

const assertMovable = async (db: Db, a: Actor, item: ItemRow, access: BoardAccess) => {
  assertBoard(access, 'item.move_group');
  assertAssigned(access, a.user, item, await itemCells(db, item.id), await listColumns(db, item.boardId));
};

/** POST /items/:id/move-to-board — a top-level item (with its subitems) to another board. */
export const moveItemToBoard = async (
  db: Db,
  a: Actor,
  itemId: string,
  input: { board_id: string; group_id?: string; mapping?: ColumnMapping },
) => {
  const { item, access } = await loadItem(db, a, itemId);
  if (item.depth > 0) throw new AppError('bad_request', 'convert_subitem_first');
  await assertMovable(db, a, item, access);
  const target = await targetAccess(db, a, input.board_id, item.boardId);
  const groups = await listGroups(db, target.board.id);
  const group = input.group_id ? groups.find((g) => g.id === input.group_id) : groups[0];
  if (!group) throw new AppError('not_found', 'Group not found');
  // No mapping sent: the automatic one (same type and title, else the only column of that type).
  const mapping = await mappingFor(db, a, input.mapping, item.boardId, target.board.id);
  const batchId = newId();
  return db.transaction(async (tx) => {
    const top = await moveItemToBoardTx(tx, a, item, target.board, group.id, mapping, batchId);
    return { ok: true as const, event_id: top.eventId, dropped: top.dropped };
  });
};

/** One top-level item (and its subitems) to the bottom of `groupId` on `target` — single or batch. */
export const moveItemToBoardTx = async (
  tx: Db,
  a: Actor,
  item: ItemRow,
  target: BoardRow,
  groupId: string,
  mapping: Map<string, string | null>,
  batchId: string,
) => {
  const position = rankBetween(await lastItemPosition(tx, groupId), null);
  const top = await relocateWithEvent(
    tx,
    a,
    item,
    { boardId: target.id, groupId, parentItemId: null, rootItemId: null, depth: 0, position },
    mapping,
    'item.moved_to_board',
    batchId,
  );
  const dropped = top.dropped + (await moveDescendants(tx, a, item, target, batchId));
  // On a board that computes names the item (and its subitems there) get their computed names.
  await noteItemsChanged(tx, nameWho(a), [item.id, ...(await descendantsOf(tx, item.id)).map((d) => d.id)]);
  return { eventId: top.eventId, dropped };
};

/** Target board, group and mapping for a batch move, checked once (bulk `move_to_board`). */
export const prepareBulkMove = async (
  db: Db,
  a: Actor,
  sourceBoardId: string,
  input: { board_id: string; group_id?: string; mapping: ColumnMapping },
) => {
  const target = await targetAccess(db, a, input.board_id, sourceBoardId);
  const groups = await listGroups(db, target.board.id);
  const group = input.group_id ? groups.find((g) => g.id === input.group_id) : groups[0];
  if (!group) throw new AppError('not_found', 'Group not found');
  const mapping = await guardedMapping(db, a, input.mapping, sourceBoardId, target.board.id);
  return { target: target.board, groupId: group.id, mapping };
};

/** POST /boards/:id/groups/:gid/move-to-board — the group row (same id) and its items, one batch. */
export const moveGroupToBoard = async (
  db: Db,
  a: Actor,
  boardId: string,
  groupId: string,
  input: { board_id: string; mapping: ColumnMapping },
) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'group.delete');
  const groups = await listGroups(db, boardId);
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw new AppError('not_found', 'Group not found');
  if (groups.length <= 1) throw new AppError('last_group', 'A board keeps at least one group');
  const target = await targetAccess(db, a, input.board_id, boardId);
  assertBoard(target, 'group.create');
  const mapping = await guardedMapping(db, a, input.mapping, boardId, target.board.id);
  const batchId = newId();
  return db.transaction(async (tx) => {
    const targetGroups = await listGroups(tx, target.board.id);
    const position = rankBetween(targetGroups.at(-1)?.position ?? null, null);
    await updateGroupRow(tx, group.id, { boardId: target.board.id, position });
    const eventId = await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'group.moved_to_board',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: target.board.id,
      batchId,
      before: { id: group.id, board_id: boardId, position: group.position },
      after: { id: group.id, board_id: target.board.id, position },
    });
    let dropped = 0;
    for (const item of await activeItemsOfGroupRows(tx, group.id)) {
      dropped += (
        await relocateWithEvent(
          tx,
          a,
          item,
          {
            boardId: target.board.id,
            groupId: group.id,
            parentItemId: null,
            rootItemId: null,
            depth: 0,
            position: item.position,
          },
          mapping,
          'item.moved_to_board',
          batchId,
        )
      ).dropped;
      dropped += await moveDescendants(tx, a, item, target.board, batchId);
    }
    return { ok: true as const, event_id: eventId, dropped };
  });
};

/**
 * POST /items/:id/convert (07 §3.7): an item becomes a subitem of another item of its board (`parent_item_id`),
 * or a subitem becomes an item of the board (`group_id`). Its own subitems come along, one level deeper/shallower.
 */
export const convertItem = async (
  db: Db,
  a: Actor,
  itemId: string,
  input: { parent_item_id?: string; group_id?: string; mapping?: ColumnMapping },
  /** → an item: right after this item of the group (outdent: after its old parent); default = last. */
  opts: { afterItemId?: string } = {},
) => {
  const { item, access } = await loadItem(db, a, itemId);
  assertBoard(access, 'item.update');
  assertBoard(access, 'item.create');
  const rootBoard = access.board.parentBoardId
    ? (await loadBoardAccess(db, a.ctx, a.user, access.board.parentBoardId)).board
    : access.board;
  const batchId = newId();

  if (input.parent_item_id) {
    // → subitem of `parent` (an item of the same root board, not itself nor its own subitem).
    const parent = await findItem(db, a.ctx.accountId, input.parent_item_id);
    if (!parent || (parent.boardId !== rootBoard.id && parent.boardId !== access.board.id)) {
      throw new AppError('bad_request', 'bad_parent');
    }
    return db.transaction(async (tx) => {
      const sub = (await findSubBoard(tx, rootBoard.id)) ?? (await ensureSubBoard(tx, a, rootBoard));
      const mapping =
        item.boardId === sub.id
          ? new Map<string, string | null>()
          : await mappingFor(tx, a, input.mapping, item.boardId, sub.id);
      const top = await convertToSubitemTx(tx, a, item, parent, rootBoard, sub, mapping, batchId);
      return { ok: true as const, event_id: top.eventId, dropped: top.dropped };
    });
  }

  // → a top-level item of the root board, in `group_id`.
  if (item.depth === 0) throw new AppError('bad_request', 'already_an_item');
  const group = (await listGroups(db, rootBoard.id)).find((g) => g.id === input.group_id);
  if (!group) throw new AppError('not_found', 'Group not found');
  const mapping = await mappingFor(db, a, input.mapping, item.boardId, rootBoard.id);
  return db.transaction(async (tx) => {
    const top = await convertToItemTx(tx, a, item, rootBoard, group.id, mapping, batchId, opts.afterItemId);
    return { ok: true as const, event_id: top.eventId, dropped: top.dropped };
  });
};

/**
 * The deepest level of `item`'s own branch below it (0 = no subitems) and the branch itself. Used to keep a
 * moved branch within the board's `hierarchy_depth_max` and to refuse a move under the item's own descendant.
 */
export const branchOf = async (db: Db, item: ItemRow) => {
  const descendants = await descendantsOf(db, item.id);
  return { descendants, deepest: Math.max(0, ...descendants.map((d) => d.depth - item.depth)) };
};

/** The board's hierarchy setting (`hierarchy_depth_max`) holds for the whole branch landing at `depth`. */
export const assertBranchFits = (depth: number, deepest: number, hierarchyDepthMax: number | null | undefined) => {
  const max = effectiveDepthMax(hierarchyDepthMax);
  if (depth + deepest > max) throw new AppError('depth_exceeded', 'tree_too_deep', { max });
};

/**
 * Inside the caller's transaction: `item` (an item of the root board, or a subitem) becomes the last subitem of
 * `parent`, on `sub` (the root board's sub-board) with `mapping` (internal column ids; empty when it is on `sub`
 * already). Its own subitems come along, re-levelled. Never under itself or its own subitems; the board's
 * hierarchy depth holds for the whole branch. One `item.converted` event per moved row, all with `batchId`.
 */
export const convertToSubitemTx = async (
  tx: Db,
  a: Actor,
  item: ItemRow,
  parent: ItemRow,
  rootBoard: BoardRow,
  sub: BoardRow,
  mapping: Map<string, string | null>,
  batchId: string,
) => {
  const { descendants, deepest } = await branchOf(tx, item);
  if (parent.id === item.id || descendants.some((d) => d.id === parent.id)) {
    throw new AppError('bad_request', 'tree_cycle');
  }
  const depth = parent.depth + 1;
  assertBranchFits(depth, deepest, rootBoard.hierarchyDepthMax);
  const root = parent.rootItemId ?? parent.id;
  const top = await relocateWithEvent(
    tx,
    a,
    item,
    {
      boardId: sub.id,
      groupId: null,
      parentItemId: parent.id,
      rootItemId: root,
      depth,
      position: rankBetween(await lastChildPosition(tx, parent.id), null),
    },
    mapping,
    'item.converted',
    batchId,
  );
  await shiftDescendants(tx, a, item, descendants, depth, root, batchId);
  return top;
};

/**
 * Inside the caller's transaction: a subitem becomes a top-level item of `rootBoard` in `groupId` (right after
 * `afterItemId` when it is there, else last), cells by `mapping`; its own subitems come along one level up.
 */
export const convertToItemTx = async (
  tx: Db,
  a: Actor,
  item: ItemRow,
  rootBoard: BoardRow,
  groupId: string,
  mapping: Map<string, string | null>,
  batchId: string,
  afterItemId?: string,
) => {
  const descendants = await descendantsOf(tx, item.id);
  const top = await relocateWithEvent(
    tx,
    a,
    item,
    {
      boardId: rootBoard.id,
      groupId,
      parentItemId: null,
      rootItemId: null,
      depth: 0,
      position: await topLevelPosition(tx, groupId, afterItemId),
    },
    mapping,
    'item.converted',
    batchId,
  );
  await shiftDescendants(tx, a, item, descendants, 0, item.id, batchId);
  return top;
};

/** The column mapping of a hierarchy move between `fromBoardId` and `toBoardId` (automatic when none is sent). */
export const hierarchyMapping = (
  db: Db,
  a: Actor,
  mapping: ColumnMapping | undefined,
  fromBoardId: string,
  toBoardId: string,
) => mappingFor(db, a, mapping, fromBoardId, toBoardId);

/** A top-level place in `groupId`: right after `afterItemId` when it is there, else last. */
const topLevelPosition = async (tx: Db, groupId: string, afterItemId?: string) => {
  const siblings = await activeItemsOfGroupRows(tx, groupId);
  if (afterItemId && siblings.some((s) => s.id === afterItemId)) {
    return positionAmong(siblings, { after_id: afterItemId });
  }
  return rankBetween(await lastItemPosition(tx, groupId), null);
};

/** Subitems of a converted item keep their place under it, re-levelled (same sub-board, same cells). */
const shiftDescendants = async (
  tx: Db,
  a: Actor,
  item: ItemRow,
  descendants: ItemRow[],
  newDepth: number,
  root: string,
  batchId: string,
) => {
  for (const d of descendants) {
    await relocateWithEvent(
      tx,
      a,
      d,
      {
        boardId: d.boardId,
        groupId: null,
        parentItemId: d.parentItemId,
        rootItemId: root,
        depth: newDepth + (d.depth - item.depth),
        position: d.position,
      },
      new Map(),
      'item.converted',
      batchId,
    );
  }
};
