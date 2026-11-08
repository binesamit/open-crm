// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@bines/shared';
import type { Db } from '../../db/client';
import { recordEvent, recordEvents } from '../activity/activity.repo';
import { type ColumnRow, findColumnById, findColumnByKey, updateColumnRow } from '../boards/boards.repo';
import { deleteCell, updateItemRow, upsertCell } from './items.repo';
import {
  appendLinks,
  columnLinks,
  itemsAnyState,
  linkTargetsOf,
  outgoingLinksByColumn,
  removeLinks,
} from './relations.repo';

/**
 * Two-way board relations (03 §2.16). A pair is two board_relation columns, each linking to exactly the other's
 * board, both with `two_way: true` and `reflection_column_id` = the other's column key. Every link written on one
 * side is reflected on the other (item_links rows + the cell cache), as a side effect: the actor needs no rights
 * on the partner board, and the reflection never reflects back (it writes rows, not cells through writeLinks).
 */
type RelationSettings = {
  board_ids?: string[];
  allow_multiple?: boolean;
  two_way?: boolean;
  reflection_column_id?: string;
  [k: string]: unknown;
};
const settingsOf = (c: ColumnRow) => (c.settings ?? {}) as RelationSettings;

/** The single board a relation column links to (two-way needs exactly one), else null. */
export const singleTargetBoard = (c: ColumnRow) => {
  const ids = settingsOf(c).board_ids ?? [];
  return c.type === 'board_relation' && ids.length === 1 ? ids[0]! : null;
};

/** Settings without the two-way pair (disable, a copied board, a template). */
export const withoutTwoWay = (settings: Record<string, unknown>) => {
  const { two_way: _w, reflection_column_id: _r, ...rest } = settings;
  return rest;
};

/**
 * The live partner of a two-way column, or null when the column is one-way or the pair is broken (the partner
 * was deleted, points elsewhere, or no longer links to this board) — a broken pair writes one side only.
 */
export const partnerOf = async (db: Db, column: ColumnRow): Promise<ColumnRow | null> => {
  const s = settingsOf(column);
  const target = singleTargetBoard(column);
  if (!s.two_way || !s.reflection_column_id || !target) return null;
  const partner = await findColumnByKey(db, target, s.reflection_column_id);
  if (!partner || partner.id === column.id || partner.accountId !== column.accountId) return null;
  const ps = settingsOf(partner);
  if (!ps.two_way || ps.reflection_column_id !== column.key || singleTargetBoard(partner) !== column.boardId)
    return null;
  return partner;
};

const sameList = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Rewrites the relation cell cache (`{item_ids}`, names, count) of these items from item_links. */
export const refreshRelationCells = async (
  db: Db,
  p: { accountId: string; column: ColumnRow; itemIds: string[]; actorId: string | null },
) => {
  if (!p.itemIds.length) return;
  const links = await linkTargetsOf(db, p.column.id, p.itemIds);
  const targets = await itemsAnyState(db, p.accountId, [...new Set([...links.values()].flat().map((l) => l.to))]);
  // Names of live targets only — a trashed item does not show, like in a one-way cell.
  const names = new Map(targets.filter((t) => !t.deletedAt).map((t) => [t.id, t.name]));
  for (const itemId of p.itemIds) {
    const ids = (links.get(itemId) ?? []).map((l) => l.to);
    if (!ids.length) {
      await deleteCell(db, itemId, p.column.id);
      continue;
    }
    await upsertCell(db, {
      itemId,
      columnId: p.column.id,
      accountId: p.accountId,
      boardId: p.column.boardId,
      value: { item_ids: ids },
      textValue: ids.flatMap((id) => (names.has(id) ? [names.get(id)!] : [])).join(', '),
      numberValue: ids.length,
      dateValue: null,
      dateEndValue: null,
      updatedBy: p.actorId,
      updatedByType: 'user',
    });
  }
};

export type ReflectionInput = {
  accountId: string;
  /** The column whose links changed (internal id). */
  columnId: string;
  /** The item whose links changed. */
  fromItemId: string;
  /** Its targets before and after the change. */
  before: string[];
  after: string[];
  /** Who the partner's `cell.changed` events are recorded for (a user id; null = system). */
  actorId: string | null;
  requestId?: string | null;
  /** The column row when the caller has it (saves a read). */
  column?: ColumnRow;
};

/**
 * Reflects one relation cell's change on the partner column (two-way pairs only; a no-op otherwise): each added
 * target gets `fromItemId` appended to its partner cell, each removed target loses it. Records `cell.changed` on
 * every partner item that changed (meta.reflected_from), so live boards, activity and automations see it. Works
 * inside the caller's transaction; also the entry point for importers. Returns the partner item ids changed.
 */
export const syncReflection = async (tx: Db, p: ReflectionInput): Promise<string[]> => {
  const column = p.column ?? (await findColumnById(tx, p.columnId));
  if (!column || column.type !== 'board_relation') return [];
  const partner = await partnerOf(tx, column);
  if (!partner) return [];
  const before = new Set(p.before);
  const after = new Set(p.after);
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  if (!added.length && !removed.length) return [];
  const rows = new Map((await itemsAnyState(tx, p.accountId, [...added, ...removed])).map((r) => [r.id, r]));
  // A reverse link lives on the partner's board only; removing one works wherever the item is now.
  const add = added.filter((id) => rows.get(id)?.boardId === partner.boardId);
  const remove = removed.filter((id) => rows.has(id));
  const touched = [...new Set([...add, ...remove])];
  if (!touched.length) return [];

  const prev = await linkTargetsOf(tx, partner.id, touched);
  await removeLinks(
    tx,
    partner.id,
    remove.map((to) => ({ from: to, to: p.fromItemId })),
  );
  await appendLinks(
    tx,
    p.accountId,
    partner.id,
    add.map((to) => ({ from: to, to: p.fromItemId })),
    p.actorId,
  );
  const next = await linkTargetsOf(tx, partner.id, touched);
  const ids = (m: typeof prev, id: string) => (m.get(id) ?? []).map((l) => l.to);
  const changed = touched.filter((id) => !sameList(ids(prev, id), ids(next, id)));
  await refreshRelationCells(tx, { accountId: p.accountId, column: partner, itemIds: changed, actorId: p.actorId });

  // Events for live items (a trashed one changes silently, and shows the change when it is restored).
  const live = changed.filter((id) => !rows.get(id)?.deletedAt);
  const now = new Date();
  for (const id of live) await updateItemRow(tx, id, { lastCellChangeAt: now, lastCellChangeBy: p.actorId });
  const value = (list: string[]) => (list.length ? { item_ids: list } : null);
  await recordEvents(
    tx,
    live.map((id) => ({
      accountId: p.accountId,
      type: 'cell.changed',
      actorId: p.actorId,
      requestId: p.requestId ?? null,
      boardId: rows.get(id)!.boardId,
      itemId: id,
      columnId: partner.id,
      batchId: null,
      before: { value: value(ids(prev, id)) },
      after: { value: value(ids(next, id)) },
      meta: {
        column_key: partner.key,
        column_type: partner.type,
        reflected_from: { board_id: column.boardId, item_id: p.fromItemId, column_key: column.key },
      },
    })),
  );
  return changed;
};

/**
 * Runs `fn` (which rewrites an item's outgoing links wholesale — a move between boards, its undo) and reflects
 * every two-way column whose links changed: the old column's partner loses the item, the new one's gains it.
 */
export const reflectItemLinks = async <T>(
  tx: Db,
  p: { accountId: string; itemId: string; actorId: string | null; requestId?: string | null },
  fn: () => Promise<T>,
): Promise<T> => {
  const before = await outgoingLinksByColumn(tx, p.itemId);
  const result = await fn();
  const after = await outgoingLinksByColumn(tx, p.itemId);
  for (const columnId of new Set([...before.keys(), ...after.keys()])) {
    await syncReflection(tx, {
      accountId: p.accountId,
      columnId,
      fromItemId: p.itemId,
      before: before.get(columnId) ?? [],
      after: after.get(columnId) ?? [],
      actorId: p.actorId,
      requestId: p.requestId,
    });
  }
  return result;
};

type Who = { accountId: string; actorId: string | null; requestId?: string | null };

/**
 * Prod (product owner: "a board taken off the column takes its values with it"): the column's links to items of
 * `boards` go, every changed cell is re-cached and gets a `cell.changed` in `batchId` (the settings change's batch:
 * one undo brings the board and the links back). Returns how many links were removed.
 */
export const dropLinksToBoards = async (tx: Db, who: Who, column: ColumnRow, boards: string[], batchId: string) => {
  if (!boards.length) return 0;
  const links = await columnLinks(tx, column.id);
  const ends = new Map(
    (await itemsAnyState(tx, who.accountId, [...new Set(links.flatMap((l) => [l.from, l.to]))])).map((r) => [r.id, r]),
  );
  const gone = new Set(boards);
  const drop = links.filter((l) => gone.has(ends.get(l.to)?.boardId ?? ''));
  if (!drop.length) return 0;
  const touched = [...new Set(drop.map((l) => l.from))];
  const prev = await linkTargetsOf(tx, column.id, touched);
  await removeLinks(tx, column.id, drop);
  await refreshRelationCells(tx, { accountId: who.accountId, column, itemIds: touched, actorId: who.actorId });
  // Events for live items (a trashed one changes silently, as in a reflection).
  const live = touched.filter((id) => !ends.get(id)?.deletedAt);
  const now = new Date();
  for (const id of live) await updateItemRow(tx, id, { lastCellChangeAt: now, lastCellChangeBy: who.actorId });
  const ids = (id: string) => (prev.get(id) ?? []).map((l) => l.to);
  const value = (list: string[]) => (list.length ? { item_ids: list } : null);
  await recordEvents(
    tx,
    live.map((id) => ({
      accountId: who.accountId,
      type: 'cell.changed',
      actorId: who.actorId,
      requestId: who.requestId ?? null,
      boardId: column.boardId,
      itemId: id,
      columnId: column.id,
      batchId,
      before: { value: value(ids(id)) },
      after: { value: value(ids(id).filter((to) => !gone.has(ends.get(to)?.boardId ?? ''))) },
      meta: { column_key: column.key, column_type: column.type, relation_boards_removed: boards },
    })),
  );
  return drop.length;
};

const writeSettings = async (tx: Db, who: Who, column: ColumnRow, settings: Record<string, unknown>, meta: object) => {
  await updateColumnRow(tx, column.id, { settings });
  await recordEvent(tx, {
    accountId: who.accountId,
    type: 'column.settings_changed',
    actorId: who.actorId,
    requestId: who.requestId ?? null,
    boardId: column.boardId,
    columnId: column.id,
    before: { settings: column.settings },
    after: { settings },
    meta: { two_way: meta },
  });
};

/**
 * Enabling two-way: every existing link on either side gets its reverse on the other (union — nothing is
 * removed). Only links whose ends sit on the pair's boards count. Cells are re-cached; no per-cell events (one
 * `column.settings_changed` per side refreshes live boards). Returns how many reverse links were added.
 */
export const backfillTwoWay = async (tx: Db, who: Who, a: ColumnRow, b: ColumnRow) => {
  const [la, lb] = [await columnLinks(tx, a.id), await columnLinks(tx, b.id)];
  const boards = new Map(
    (await itemsAnyState(tx, who.accountId, [...new Set([...la, ...lb].flatMap((l) => [l.from, l.to]))])).map((r) => [
      r.id,
      r.boardId,
    ]),
  );
  const reverse = (links: typeof la, from: ColumnRow, to: ColumnRow) => {
    const have = new Set((from === a ? lb : la).map((l) => `${l.from}:${l.to}`));
    return links
      .filter((l) => boards.get(l.from) === from.boardId && boards.get(l.to) === to.boardId)
      .map((l) => ({ from: l.to, to: l.from }))
      .filter((l) => !have.has(`${l.from}:${l.to}`));
  };
  const toB = reverse(la, a, b);
  const toA = reverse(lb, b, a);
  await appendLinks(tx, who.accountId, b.id, toB, who.actorId);
  await appendLinks(tx, who.accountId, a.id, toA, who.actorId);
  await refreshRelationCells(tx, { ...who, column: b, itemIds: [...new Set(toB.map((l) => l.from))] });
  await refreshRelationCells(tx, { ...who, column: a, itemIds: [...new Set(toA.map((l) => l.from))] });
  return toA.length + toB.length;
};

/**
 * Makes `column` and `partner` a two-way pair (both settings), then backfills the reverse links. Both must be
 * board_relation columns of this account linking to exactly each other's board; neither may be paired with a
 * third column. Idempotent for a pair that already exists. Importers call it after creating both columns.
 */
export const pairTwoWayColumns = async (
  tx: Db,
  who: Who,
  column: ColumnRow,
  partner: ColumnRow,
  opts: { backfill?: boolean } = {},
) => {
  const fail = (reason: string) => new AppError('two_way_unavailable', reason, { reason });
  if (column.type !== 'board_relation' || partner.type !== 'board_relation') throw fail('not_a_relation');
  if (column.id === partner.id) throw fail('same_column');
  if (column.accountId !== who.accountId || partner.accountId !== who.accountId) throw fail('not_found');
  if (singleTargetBoard(column) !== partner.boardId) throw fail('one_target_board');
  if (singleTargetBoard(partner) !== column.boardId) throw fail('partner_must_point_back');
  const cs = settingsOf(column);
  const ps = settingsOf(partner);
  if (cs.two_way && cs.reflection_column_id && cs.reflection_column_id !== partner.key) {
    if (await partnerOf(tx, column)) throw fail('already_paired');
  }
  if (ps.two_way && ps.reflection_column_id && ps.reflection_column_id !== column.key) {
    if (await partnerOf(tx, partner)) throw fail('partner_already_paired');
  }
  const pairWith = (c: ColumnRow, other: ColumnRow) => ({
    ...c.settings,
    two_way: true,
    reflection_column_id: other.key,
  });
  const paired = (c: ColumnRow, other: ColumnRow) =>
    settingsOf(c).two_way === true && settingsOf(c).reflection_column_id === other.key;
  const meta = (other: ColumnRow) => ({ state: 'paired', board_id: other.boardId, column_key: other.key });
  if (!paired(column, partner)) await writeSettings(tx, who, column, pairWith(column, partner), meta(partner));
  if (!paired(partner, column)) await writeSettings(tx, who, partner, pairWith(partner, column), meta(column));
  const fresh = { ...column, settings: pairWith(column, partner) };
  const freshPartner = { ...partner, settings: pairWith(partner, column) };
  const added = opts.backfill === false ? 0 : await backfillTwoWay(tx, who, fresh, freshPartner);
  return { column: fresh, partner: freshPartner, backfilled: added };
};

/**
 * Ends a pair: both columns become one-way (their links and cells stay). `keepOwn`: the column itself keeps its
 * settings — it is going to the trash, and a restore pairs it again when it can (`repairTwoWayOnRestore`).
 */
export const unpairTwoWay = async (tx: Db, who: Who, column: ColumnRow, opts: { keepOwn?: boolean } = {}) => {
  const s = settingsOf(column);
  if (!s.two_way && !s.reflection_column_id) return null;
  const partner = await partnerOf(tx, column);
  const meta = {
    state: opts.keepOwn ? 'partner_deleted' : 'unpaired',
    board_id: column.boardId,
    column_key: column.key,
  };
  if (!opts.keepOwn)
    await writeSettings(tx, who, column, withoutTwoWay(column.settings), { ...meta, state: 'unpaired' });
  if (partner) await writeSettings(tx, who, partner, withoutTwoWay(partner.settings), meta);
  return partner;
};

/**
 * A two-way column back from the trash: paired again (with a backfill) when its partner is live, still links
 * back to this board and is not paired with another column; otherwise it becomes one-way.
 */
export const repairTwoWayOnRestore = async (tx: Db, who: Who, column: ColumnRow) => {
  const s = settingsOf(column);
  if (column.type !== 'board_relation' || (!s.two_way && !s.reflection_column_id)) return;
  const target = singleTargetBoard(column);
  const partner = target && s.reflection_column_id ? await findColumnByKey(tx, target, s.reflection_column_id) : null;
  if (partner && partner.type === 'board_relation' && partner.id !== column.id) {
    try {
      await pairTwoWayColumns(tx, who, column, partner);
      return;
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== 'two_way_unavailable') throw e;
    }
  }
  await writeSettings(tx, who, column, withoutTwoWay(column.settings), {
    state: 'unpaired',
    board_id: column.boardId,
    column_key: column.key,
  });
};
