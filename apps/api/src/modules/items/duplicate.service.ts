// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, columnTypes, newId, ownWriter, rankBetween } from '@bines/shared';
import type { Db } from '../../db/client';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, loadBoardAccess, positionAmong } from '../boards/boards.access';
import {
  type ColumnRow,
  columnsByBoardIds,
  findSubBoard,
  insertGroups,
  itemKeyFormat,
  listGroups,
  nextItemKeySeq,
} from '../boards/boards.repo';
import { groupDto } from '../boards/boards.service';
import { copyCellDoc } from '../docs/docs.cell';
import { copyUpdates } from '../updates/updates.repo';
import {
  activeItemsOfGroupRows,
  childItemsOf,
  insertItem,
  itemCells,
  type ItemRow,
  linksFromItems,
  neighbourPositions,
  replaceLinks,
  upsertCell,
} from './items.repo';
import { type Actor, freshItem, loadItem, nameWho } from './items.service';
import { noteItemsChanged } from './names.service';
import { syncReflection } from './relations.service';
import { accountLocale, st } from '../../lib/i18n';
import type { Locale } from '@bines/shared';

/**
 * Duplicate (07 §4.2). Cells are copied except the time log and votes (a copy starts at zero) and files (their
 * own flow); relation links are copied; subitems are copied with their own cells; updates only when asked.
 */
const copiable = (c: ColumnRow) => {
  const def = columnTypes.get(c.type);
  return !!def && def.storage === 'cell' && !ownWriter(def);
};

type Placement = {
  groupId: string | null;
  parentItemId: string | null;
  rootItemId: string | null;
  position: string;
  name: string;
};

/**
 * Into another board (duplicating a board, 07 §4.1): items land on `boardOf(source board)`, cells and links on
 * `columnMap(source column)`, and `idMap` collects old → new ids so links between copied items can be remapped.
 */
export type CopyInto = {
  boardOf: (sourceBoardId: string) => string;
  columnMap: Map<string, string>;
  idMap: Map<string, string>;
};

/** Copies `source` (and its subtree) to `at`; returns the new item's id. */
export const copyTree = async (
  tx: Db,
  a: Actor,
  source: ItemRow,
  at: Placement,
  columnsOf: Map<string, ColumnRow[]>,
  withUpdates: boolean,
  into?: CopyInto,
): Promise<string> => {
  const id = newId();
  into?.idMap.set(source.id, id);
  const boardId = into?.boardOf(source.boardId) ?? source.boardId;
  const colId = (c: string) => into?.columnMap.get(c) ?? c;
  const key = (await itemKeyFormat(tx, boardId)) ? await nextItemKeySeq(tx, boardId) : undefined;
  await insertItem(tx, {
    id,
    accountId: a.ctx.accountId,
    boardId,
    groupId: at.groupId,
    parentItemId: at.parentItemId,
    rootItemId: at.rootItemId,
    depth: source.depth,
    position: at.position,
    name: at.name,
    keySeq: key ? Number(key.seq) : null,
    createdBy: a.user.id,
    creatorType: 'user',
  });

  const columns = new Map((columnsOf.get(source.boardId) ?? []).map((c) => [c.id, c]));
  for (const cell of await itemCells(tx, source.id)) {
    const column = columns.get(cell.columnId);
    // A doc in the cell (M8): the copy gets a copy of the doc.
    if (column && columnTypes.get(column.type)?.engine === 'doc') {
      await copyCellDoc(tx, a, cell.value, { itemId: id, boardId, columnId: colId(cell.columnId) });
      continue;
    }
    if (!column || !copiable(column)) continue;
    await upsertCell(tx, {
      itemId: id,
      columnId: colId(cell.columnId),
      accountId: a.ctx.accountId,
      boardId,
      value: cell.value,
      textValue: cell.textValue,
      numberValue: cell.numberValue,
      dateValue: cell.dateValue,
      dateEndValue: cell.dateEndValue,
      updatedBy: a.user.id,
      updatedByType: 'user',
    });
  }
  const links = new Map<string, string[]>();
  for (const l of await linksFromItems(tx, [source.id]))
    links.set(l.columnId, [...(links.get(l.columnId) ?? []), l.toItemId]);
  for (const [columnId, toItemIds] of links) {
    await replaceLinks(tx, {
      accountId: a.ctx.accountId,
      columnId: colId(columnId),
      fromItemId: id,
      toItemIds,
      createdBy: a.user.id,
    });
    // A two-way column: the copy shows up on the linked items too (03 §2.16).
    await syncReflection(tx, {
      accountId: a.ctx.accountId,
      columnId: colId(columnId),
      fromItemId: id,
      before: [],
      after: toItemIds,
      actorId: a.user.id,
      requestId: a.requestId,
    });
  }
  if (withUpdates) await copyUpdates(tx, source.id, id, boardId, newId);
  // A board that computes names: the copy gets its computed name, not "<name> (copy)".
  await noteItemsChanged(tx, nameWho(a), [id]);

  const root = at.rootItemId ?? id;
  for (const child of await childItemsOf(tx, [source.id])) {
    await copyTree(
      tx,
      a,
      child,
      { groupId: null, parentItemId: id, rootItemId: root, position: child.position, name: child.name },
      columnsOf,
      withUpdates,
      into,
    );
  }
  return id;
};

/** Columns of the source board and of its sub-board (subitems are copied too). */
export const columnsFor = async (tx: Db, boardIds: string[]) => {
  const map = new Map<string, ColumnRow[]>();
  for (const c of await columnsByBoardIds(tx, boardIds)) map.set(c.boardId, [...(map.get(c.boardId) ?? []), c]);
  return map;
};
/** "<name> (copy)" in the account's language. */
const copyName = (name: string, lang: Locale) => st('server.copyOf', { name }, lang).slice(0, 255);

/** One copy of `item` right below it (inside the caller's transaction); returns [copy id, event id]. */
export const duplicateItemTx = async (
  tx: Db,
  a: Actor,
  item: ItemRow,
  opts: { withUpdates: boolean; batchId: string | null; subBoardId: string | null },
) => {
  const columnsOf = await columnsFor(tx, [item.boardId, ...(opts.subBoardId ? [opts.subBoardId] : [])]);
  const lang = await accountLocale(tx, a.ctx.accountId);
  let position: string;
  if (item.groupId) {
    const n = await neighbourPositions(tx, item.groupId, item.id);
    position = rankBetween(n?.before ?? item.position, n?.after ?? null);
  } else {
    // A subitem's copy goes right after it among its siblings.
    const siblings = (await childItemsOf(tx, [item.parentItemId!])).map((s) => s.position);
    const next = siblings.find((p) => p > item.position) ?? null;
    position = rankBetween(item.position, next);
  }
  const id = await copyTree(
    tx,
    a,
    item,
    {
      groupId: item.groupId,
      parentItemId: item.parentItemId,
      rootItemId: item.rootItemId,
      position,
      name: copyName(item.name, lang),
    },
    columnsOf,
    opts.withUpdates,
  );
  const eventId = await recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'item.duplicated',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: item.boardId,
    itemId: id,
    batchId: opts.batchId,
    after: { name: copyName(item.name, lang), group_id: item.groupId },
    meta: { from_item_id: item.id, with_updates: opts.withUpdates },
  });
  return [id, eventId] as const;
};

/** POST /items/:id/duplicate → the copy (201). */
export const duplicateItem = async (db: Db, a: Actor, itemId: string, withUpdates = false) => {
  const { item, access } = await loadItem(db, a, itemId);
  assertBoard(access, 'item.create');
  const subBoardId = await subBoardIdOf(db, access.board);
  const [id] = await db.transaction((tx) => duplicateItemTx(tx, a, item, { withUpdates, batchId: null, subBoardId }));
  return freshItem(db, a, access, id);
};

const subBoardIdOf = async (db: Db, board: { id: string; parentBoardId: string | null }) =>
  board.parentBoardId ? null : ((await findSubBoard(db, board.id))?.id ?? null); // a subitem's tree is on its own board

/** POST /boards/:id/groups/:gid/duplicate — a copy of the group right below it, with its items by default. */
export const duplicateGroup = async (db: Db, a: Actor, boardId: string, groupId: string, withItems = true) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'group.create');
  if (withItems) assertBoard(access, 'item.create');
  const groups = await listGroups(db, boardId);
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw new AppError('not_found', 'Group not found');
  const subBoardId = await subBoardIdOf(db, access.board);
  const newGroupId = newId();
  const lang = await accountLocale(db, a.ctx.accountId);
  await db.transaction(async (tx) => {
    await insertGroups(tx, [
      {
        id: newGroupId,
        accountId: a.ctx.accountId,
        boardId,
        title: copyName(group.title, lang),
        color: group.color,
        position: positionAmong(groups, { after_id: groupId }),
        createdBy: a.user.id,
      },
    ]);
    let count = 0;
    if (withItems) {
      const columnsOf = await columnsFor(tx, [boardId, ...(subBoardId ? [subBoardId] : [])]);
      for (const item of await activeItemsOfGroupRows(tx, groupId)) {
        await copyTree(
          tx,
          a,
          item,
          { groupId: newGroupId, parentItemId: null, rootItemId: null, position: item.position, name: item.name },
          columnsOf,
          false,
        );
        count++;
      }
    }
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'group.duplicated',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      after: { id: newGroupId, title: copyName(group.title, lang), color: group.color },
      meta: { from_group_id: groupId, item_count: count },
    });
  });
  return groupDto((await listGroups(db, boardId)).find((g) => g.id === newGroupId)!);
};
