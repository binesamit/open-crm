// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type ColumnMapping, newId } from '@bines/shared';
import type { Db } from '../../db/client';
import { assertBoard, type BoardAccess, loadBoardAccess } from '../boards/boards.access';
import { findSubBoard, listColumns } from '../boards/boards.repo';
import { findItem, itemCells, type ItemRow } from './items.repo';
import { type Actor, assertAssigned, loadItem } from './items.service';
import { convertToItemTx, convertToSubitemTx, hierarchyMapping } from './move.service';
import { ensureSubBoard, reparentTx } from './subitems.service';

/**
 * Moves inside a board's hierarchy — the one service behind the batch bar's "move in
 * hierarchy" (bulk actions `move_under` / `move_up`), the row menu's "move up one level" (POST /items/:id/outdent)
 * and the MCP tool `move_item_in_hierarchy`.
 *
 * - `move_under`: each item becomes the last subitem of `parent_item_id` — an item of the same board or one of its
 *   subitems. An item of the board goes to the board's sub-board (created on first use), its cells by `mapping`
 *   (automatic by type + title when none is sent); a subitem stays on the sub-board (cells kept).
 * - `move_up`: each subitem one level up — a sub-subitem under its grandparent, a subitem to an item of the board
 *   in its parent's group (cells auto-mapped back), each right after its old parent, in the selection's order.
 *
 * Rules: an item's own subitems always come along (re-levelled); the whole branch must fit the board's hierarchy
 * depth setting (`hierarchy_depth_max`), else the request is refused (`tree_too_deep`) — nothing is cut off or
 * left behind. Never under itself or one of its own subitems (`tree_cycle`). A checked item whose ancestor is
 * checked too moves with that ancestor, not on its own. Rights: `item.update` on the items' board (and their
 * assignment rule, edit_assigned); `item.create` on the board the rows land on when they change board (the
 * sub-board for items going under an item, the board for subitems becoming items). Every moved row is an
 * `item.converted` event with the full snapshot, all of one batch: one undo puts everything back.
 */
export type TreeMove = { type: 'move_under'; parent_item_id: string; mapping?: ColumnMapping } | { type: 'move_up' };

export type TreePlan = {
  to: TreeMove;
  /** The board of the selected rows (the board, or its sub-board) and the root board. */
  source: BoardAccess;
  root: BoardAccess;
  parent: ItemRow | null;
  /** Selected rows moving along with a selected ancestor. */
  carried: Set<string>;
  /** `move_up`: the last row placed after each old parent — keeps the selection's order. */
  after: Map<string, string>;
  mappings: Map<string, Map<string, string | null>>;
};

export type TreeOutcome =
  { kind: 'moved'; eventId: string; dropped: number } | { kind: 'carried' } | { kind: 'skipped' };

/** Of `rows` (all on one board), those that have a selected ancestor: they move along with it. */
const carriedRows = async (db: Db, accountId: string, rows: ItemRow[]) => {
  const selected = new Set(rows.map((r) => r.id));
  const known = new Map(rows.map((r) => [r.id, r]));
  const out = new Set<string>();
  for (const row of rows) {
    let at = row.parentItemId;
    while (at) {
      if (selected.has(at)) {
        out.add(row.id);
        break;
      }
      let up = known.get(at);
      if (!up) {
        up = await findItem(db, accountId, at);
        if (!up) break;
        known.set(at, up);
      }
      at = up.parentItemId;
    }
  }
  return out;
};

/** Checked once per request: the target, the boards and the rights that do not depend on a single row. */
export const prepareTreeMove = async (
  db: Db,
  a: Actor,
  source: BoardAccess,
  to: TreeMove,
  rows: ItemRow[],
): Promise<TreePlan> => {
  assertBoard(source, 'item.update');
  const root = source.board.parentBoardId
    ? await loadBoardAccess(db, a.ctx, a.user, source.board.parentBoardId)
    : source;
  let parent: ItemRow | null = null;
  if (to.type === 'move_under') {
    // Visible to the actor (404 otherwise), and in this board's hierarchy (the board or its sub-board).
    parent = (await loadItem(db, a, to.parent_item_id)).item;
    const sub = await findSubBoard(db, root.board.id);
    if (parent.boardId !== root.board.id && parent.boardId !== sub?.id) {
      throw new AppError('bad_request', 'bad_parent');
    }
    // Items of the board land on the sub-board: the actor adds rows there (a missing sub-board takes the board's).
    if (!source.board.parentBoardId) {
      assertBoard(sub ? await loadBoardAccess(db, a.ctx, a.user, sub.id) : root, 'item.create');
    }
  }
  return {
    to,
    source,
    root,
    parent,
    carried: await carriedRows(db, a.ctx.accountId, rows),
    after: new Map(),
    mappings: new Map(),
  };
};

const mappingOf = async (tx: Db, a: Actor, plan: TreePlan, from: string, to: string, mapping?: ColumnMapping) => {
  const key = `${from}>${to}`;
  let m = plan.mappings.get(key);
  if (!m) {
    m = await hierarchyMapping(tx, a, mapping, from, to);
    plan.mappings.set(key, m);
  }
  return m;
};

/** One row of the plan, inside the caller's transaction (all rows of a request share `batchId`). */
export const moveInTreeTx = async (
  tx: Db,
  a: Actor,
  plan: TreePlan,
  item: ItemRow,
  batchId: string,
): Promise<TreeOutcome> => {
  if (plan.carried.has(item.id)) return { kind: 'carried' };
  const rootBoard = plan.root.board;
  const to = plan.to;

  if (to.type === 'move_under') {
    const parent = plan.parent!;
    if (item.parentItemId === parent.id) return { kind: 'skipped' };
    if (item.parentItemId) {
      // A subitem: same sub-board, cells stay.
      const eventId = await reparentTx(tx, a, item, parent, rootBoard.hierarchyDepthMax, batchId);
      return { kind: 'moved', eventId, dropped: 0 };
    }
    const sub = (await findSubBoard(tx, rootBoard.id)) ?? (await ensureSubBoard(tx, a, rootBoard));
    const mapping = await mappingOf(tx, a, plan, item.boardId, sub.id, to.mapping);
    const top = await convertToSubitemTx(tx, a, item, parent, rootBoard, sub, mapping, batchId);
    return { kind: 'moved', ...top };
  }

  // move_up
  if (!item.parentItemId) return { kind: 'skipped' };
  const parent = await findItem(tx, a.ctx.accountId, item.parentItemId);
  if (!parent) return { kind: 'skipped' };
  const anchor = plan.after.get(parent.id) ?? parent.id;
  let out: TreeOutcome;
  if (parent.parentItemId) {
    const grand = await findItem(tx, a.ctx.accountId, parent.parentItemId);
    if (!grand) return { kind: 'skipped' };
    const eventId = await reparentTx(tx, a, item, grand, rootBoard.hierarchyDepthMax, batchId, { after_id: anchor });
    out = { kind: 'moved', eventId, dropped: 0 };
  } else {
    if (!parent.groupId) throw new AppError('bad_request', 'bad_parent');
    // The row becomes an item of the board: the actor adds items there.
    assertBoard(plan.root, 'item.create');
    const mapping = await mappingOf(tx, a, plan, item.boardId, rootBoard.id);
    const top = await convertToItemTx(tx, a, item, rootBoard, parent.groupId, mapping, batchId, anchor);
    out = { kind: 'moved', ...top };
  }
  plan.after.set(parent.id, item.id);
  return out;
};

/**
 * One item through the same service (POST /items/:id/outdent, the MCP tool): `move_up` of a top-level item and a
 * `move_under` its current parent are refused rather than silently doing nothing.
 */
export const moveItemInTree = async (
  db: Db,
  a: Actor,
  itemId: string,
  to: TreeMove,
  /** The caller's batch (an MCP call's own), so its undo reverts this move; default: a new one. */
  batchId: string = newId(),
) => {
  const { item, access } = await loadItem(db, a, itemId);
  if (to.type === 'move_up' && !item.parentItemId) throw new AppError('bad_request', 'already_an_item');
  const plan = await prepareTreeMove(db, a, access, to, [item]);
  assertAssigned(access, a.user, item, await itemCells(db, item.id), await listColumns(db, item.boardId));
  const out = await db.transaction((tx) => moveInTreeTx(tx, a, plan, item, batchId));
  if (out.kind !== 'moved') throw new AppError('bad_request', 'already_there');
  return { ok: true as const, event_id: out.eventId, dropped: out.dropped };
};

/** POST /items/:id/outdent (Fix: ) — one level up, its own subitems along; one batch, undone in one go. */
export const outdentItem = (db: Db, a: Actor, itemId: string) => moveItemInTree(db, a, itemId, { type: 'move_up' });
