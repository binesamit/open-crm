// SPDX-License-Identifier: AGPL-3.0-only
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { type BoardAccess, isOwnerOrAdmin, loadBoardAccess, readableBoardIds } from '../boards/boards.access';
import { listColumns } from '../boards/boards.repo';
import { cellsByItemIds, type CellRow, itemsByIds, type ItemRow } from './items.repo';
import { accountTeams } from './query.repo';
import type { Actor } from './items.service';

/**
 * Item-level visibility (05 §6, `boards.view_items`). Owners and admins see everything; with
 * `assigned_or_created`, everyone else sees an item they created or are assigned to — themselves or a team
 * they are in — in the board's people columns (`view_items_config.column_ids`, or any people column).
 * A subitem is visible if it is, or its top-level item is (D14). Hidden items answer 404, never 403.
 * `by_filter` (portal rules, M7) is treated as `assigned_or_created` until it is built — never as "all".
 */
export type Visibility = {
  userId: string;
  /** The user and their teams — what a people cell must contain. */
  principals: string[];
  /** People columns that assign (internal ids). */
  peopleColumns: string[];
  /** On a sub-board: the parent board's rules decide for the top-level item. */
  parent: Visibility | null;
  parentBoardId: string | null;
} | null;

// Owners as `canBoard` counts them: a guest saved as an owner is not one.
const seesAll = (access: BoardAccess) => isOwnerOrAdmin(access);

export const boardVisibility = async (db: Db, a: Actor, access: BoardAccess): Promise<Visibility> => {
  if (seesAll(access)) return null;
  // A sub-board follows its parent's rules (it has none of its own).
  const rules = access.board.parentBoardId
    ? await loadBoardAccess(db, a.ctx, a.user, access.board.parentBoardId)
    : access;
  if (rules.board.viewItems === 'all') return null;
  const teams = await accountTeams(db, a.ctx.accountId);
  const principals = [a.user.id, ...teams.filter((t) => t.member_ids.includes(a.user.id)).map((t) => t.id)];
  const own = await peopleColumnsOf(db, access, rules);
  const parent = access.board.parentBoardId
    ? {
        userId: a.user.id,
        principals,
        peopleColumns: await peopleColumnsOf(db, rules, rules),
        parent: null,
        parentBoardId: null,
      }
    : null;
  return { userId: a.user.id, principals, peopleColumns: own, parent, parentBoardId: access.board.parentBoardId };
};

/** The assigning people columns of `board` (the configured keys on the board itself; any on a sub-board). */
const peopleColumnsOf = async (db: Db, board: BoardAccess, rules: BoardAccess) => {
  const people = (await listColumns(db, board.board.id)).filter((c) => c.type === 'people');
  const configured = (rules.board.viewItemsConfig as { column_ids?: string[] | 'any_people' }).column_ids;
  if (board === rules && Array.isArray(configured))
    return people.filter((c) => configured.includes(c.key)).map((c) => c.id);
  return people.map((c) => c.id);
};

const assigned = (v: NonNullable<Visibility>, item: ItemRow, cells: CellRow[]) =>
  item.createdBy === v.userId ||
  cells.some(
    (c) =>
      c.itemId === item.id &&
      v.peopleColumns.includes(c.columnId) &&
      ((c.value as { persons_and_teams?: { id: string }[] }).persons_and_teams ?? []).some((p) =>
        v.principals.includes(p.id),
      ),
  );

/** The items of `items` this actor may see (order kept). */
export const filterVisible = async (db: Db, v: Visibility, items: ItemRow[]) => {
  if (!v || !items.length) return items;
  const cells = await cellsByItemIds(
    db,
    items.map((i) => i.id),
  );
  const direct = new Set(items.filter((i) => assigned(v, i, cells)).map((i) => i.id));
  if (v.parent) {
    // Subitems: visible through their top-level item too.
    const rootIds = [...new Set(items.filter((i) => !direct.has(i.id) && i.rootItemId).map((i) => i.rootItemId!))];
    if (rootIds.length) {
      const roots = await itemsByIds(db, items[0]!.accountId, rootIds);
      const rootCells = await cellsByItemIds(db, rootIds);
      const visibleRoots = new Set(roots.filter((r) => assigned(v.parent!, r, rootCells)).map((r) => r.id));
      for (const i of items) if (i.rootItemId && visibleRoots.has(i.rootItemId)) direct.add(i.id);
    }
  }
  return items.filter((i) => direct.has(i.id));
};

export const isVisible = async (db: Db, v: Visibility, item: ItemRow) =>
  !v || (await filterVisible(db, v, [item])).length === 1;

/** The same rule as SQL over `items i` (top-level boards; the query path). */
export const visibilitySql = (v: Visibility): SQL | null => {
  if (!v) return null;
  const principals = sql.join(
    v.principals.map((p) => sql`${p}`),
    sql`, `,
  );
  if (!v.peopleColumns.length) return sql`i.created_by = ${v.userId}`;
  const columns = sql.join(
    v.peopleColumns.map((c) => sql`${c}`),
    sql`, `,
  );
  return sql`(i.created_by = ${v.userId} or exists (
    select 1 from cells c, jsonb_array_elements(coalesce(c.value->'persons_and_teams', '[]'::jsonb)) p
    where c.item_id = i.id and c.column_id in (${columns}) and p->>'id' in (${principals})))`;
};

/**
 * Items from many boards (search, inbox): only those on boards the actor can read and that the board's
 * `view_items` lets them see. Returns the ids that pass.
 */
export const visibleAcrossBoards = async (db: Db, a: Actor, items: ItemRow[]) => {
  if (!items.length) return new Set<string>();
  const readable = await readableBoardIds(
    db,
    a.ctx,
    a.user,
    items.map((i) => i.boardId),
  );
  const out = new Set<string>();
  for (const boardId of new Set(items.map((i) => i.boardId))) {
    if (!readable.has(boardId)) continue;
    const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
    const mine = items.filter((i) => i.boardId === boardId);
    for (const i of await filterVisible(db, await boardVisibility(db, a, access), mine)) out.add(i.id);
  }
  return out;
};
