// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  choiceFilters,
  choiceQuery,
  enforcesChoiceFilter,
  normalizeChoiceSettings,
  querySchema,
  RELATION_NOT_IN_FILTER,
  viewChoiceQuery,
  viewSettingsSchema,
  type ChoiceFilter,
  type Query,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { assertBoard, loadBoardAccess } from '../boards/boards.access';
import type { ColumnRow } from '../boards/boards.repo';
import { findView } from '../views/views.repo';
import { itemsByIds } from './items.repo';
import { visibleColumns, type Actor } from './items.service';
import { matchIds, prepareQuery } from './query.service';
import { linkedTargetsOfColumn } from './relations.repo';

/**
 * Relation filters (the planning notes "RELATION-FILTERS", r19relfilter). A board_relation column offers, per linked
 * board, only items matching a shared view of that board or a filter of the column. Everything here runs with
 * the VIEWER's rights: the matching is per person ("me" conditions, items they may see), never stored.
 * The filter is not security — a linked item still shows to whoever may see it.
 */

/** Most linked items one "which of these match" pass checks (a column with more reports `truncated`). */
export const MATCH_CAP = 5000;

export type ResolvedChoice = {
  board_id: string;
  source: ChoiceFilter['mode'];
  view_id: string | null;
  /** The caption above the picker: the column's own text, else the view's name (null = "by filter"). */
  label: string | null;
  /** What it runs; null = it cannot run (the view is gone or private) — the board then offers every item. */
  query: Query | null;
  invalid: 'view_missing' | null;
};

/** One linked board's filter of a relation column, resolved to the query it runs. */
const resolveOne = async (
  db: Db,
  accountId: string,
  boardId: string,
  f: ChoiceFilter,
  caption: string | null,
): Promise<ResolvedChoice> => {
  if (f.mode === 'filter')
    return {
      board_id: boardId,
      source: 'filter',
      view_id: null,
      label: caption,
      query: choiceQuery(f.filter),
      invalid: null,
    };
  const view = await findView(db, accountId, f.view_id);
  // Only a live shared view of that board can steer a column everyone uses.
  if (!view || view.boardId !== boardId || view.visibility !== 'shared')
    return {
      board_id: boardId,
      source: 'view',
      view_id: f.view_id,
      label: caption,
      query: null,
      invalid: 'view_missing',
    };
  const parsed = viewSettingsSchema.safeParse(view.settings);
  const query = viewChoiceQuery(parsed.success ? parsed.data.query : querySchema.parse({}));
  return { board_id: boardId, source: 'view', view_id: view.id, label: caption ?? view.name, query, invalid: null };
};

/** Every filtered linked board of a relation column (boards without a filter are left out). */
export const resolveChoices = async (db: Db, accountId: string, settings: Record<string, unknown>) => {
  const caption =
    typeof settings.choice_caption === 'string' && settings.choice_caption.trim()
      ? settings.choice_caption.trim()
      : null;
  const out: ResolvedChoice[] = [];
  for (const [boardId, f] of Object.entries(choiceFilters(settings)))
    out.push(await resolveOne(db, accountId, boardId, f, caption));
  return out;
};

/** Reads that fail because the viewer cannot read the board answer "unknown" (null) instead of an error. */
const orNull = async <T>(fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError && (e.code === 'forbidden' || e.code === 'not_found')) return null;
    throw e;
  }
};

const ALL = querySchema.parse({});

/**
 * Which of `ids` (items of one board) the viewer may see, and which of those match `query`. null = the viewer
 * cannot read the board (nothing is marked). Batched: two queries, whatever the number of ids (≤ MATCH_CAP).
 */
export const matchAmong = async (db: Db, a: Actor, boardId: string, query: Query, ids: string[]) => {
  if (!ids.length) return { visible: new Set<string>(), matched: new Set<string>() };
  return orNull(async () => {
    const limit = ids.length;
    const visible = new Set((await matchIds(db, a, boardId, ALL, { ids, limit })).ids);
    const matched = new Set((await matchIds(db, a, boardId, query, { ids, limit })).ids);
    return { visible, matched };
  });
};

/** Linked items (with their boards) that the viewer may see and that do not match their board's filter. */
const unmatchedIn = async (
  db: Db,
  a: Actor,
  choices: ResolvedChoice[],
  targets: { id: string; boardId: string }[],
): Promise<string[]> => {
  const out: string[] = [];
  for (const c of choices) {
    if (!c.query) continue;
    const ids = [...new Set(targets.filter((t) => t.boardId === c.board_id).map((t) => t.id))];
    const m = await matchAmong(db, a, c.board_id, c.query, ids);
    if (!m) continue;
    for (const id of ids) if (m.visible.has(id) && !m.matched.has(id)) out.push(id);
  }
  return out;
};

/**
 * `GET …/columns/:key/relation-matches`: for one relation column, its filters and the linked items that do not
 * match them (for this viewer) — what the cells mark with ⚠ and the "has a link that does not match" filter reads.
 */
export const columnRelationMatches = async (db: Db, a: Actor, column: ColumnRow) => {
  const settings = column.settings ?? {};
  const choices = column.type === 'board_relation' ? await resolveChoices(db, a.ctx.accountId, settings) : [];
  const filters = choices.map((c) => ({
    board_id: c.board_id,
    source: c.source,
    view_id: c.view_id,
    label: c.label,
    invalid: c.invalid,
  }));
  const base = { filters, only_matching_in_cell: settings.only_matching_in_cell === true };
  if (!choices.some((c) => c.query)) return { ...base, unmatched: [] as string[], truncated: false };
  const targets = await linkedTargetsOfColumn(db, column.id, MATCH_CAP);
  const truncated = targets.length > MATCH_CAP;
  const unmatched = await unmatchedIn(db, a, choices, targets.slice(0, MATCH_CAP));
  return { ...base, unmatched, truncated };
};

/** The env a board query needs for its "has a link that does not match" rules: column key → unmatched ids. */
export const relationUnmatchedEnv = async (db: Db, a: Actor, columns: ColumnRow[], keys: string[]) => {
  const out: Record<string, string[]> = {};
  for (const key of keys) {
    const column = columns.find((c) => c.key === key && c.type === 'board_relation');
    if (column) out[key] = (await columnRelationMatches(db, a, column)).unmatched;
  }
  return out;
};

/** Who wrote a link, and what happens to new links that do not match (see `relationPolicy`). */
export type RelationPolicy = 'enforce' | 'mark' | 'drop' | 'allow';

/**
 * The policy for NEW links written by this actor (plan: "the filter applies to a new link added by a person"):
 * an undo puts back what was there (allow); automations and forms link and mark (note in the run log); bulk
 * fills drop the unmatched ones and report them; a person / API / MCP / agent is refused
 * (`relation_not_in_filter`) unless the column turned API enforcement off.
 */
export const relationPolicy = (a: Actor, settings: Record<string, unknown>, meta: Record<string, unknown>) => {
  if (meta.undo_of) return 'allow';
  if (a.relationPolicy) return a.relationPolicy;
  if (a.automation) return 'mark';
  return enforcesChoiceFilter(settings) ? 'enforce' : 'allow';
};

/** A note a service leaves for its caller's log (automation runs, bulk results). */
export type RelationNote = {
  kind: 'relation_marked' | 'relation_dropped';
  column_key: string;
  item_id: string;
  ids: string[];
  names: string[];
};

/**
 * Checks the targets a write ADDS to a relation cell against the column's filters (the existing links are never
 * checked). Returns the ids to write. `exempt`: items the actor just created from the picker ("create new item"
 * links it — marked if it does not match).
 */
export const checkNewLinks = async (
  db: Db,
  a: Actor,
  p: {
    column: ColumnRow;
    itemId: string;
    ids: string[];
    previous: string[];
    targets: { id: string; boardId: string; name: string }[];
    policy: RelationPolicy;
    exempt: Set<string>;
  },
): Promise<string[]> => {
  if (p.policy === 'allow') return p.ids;
  const before = new Set(p.previous);
  const added = p.ids.filter((id) => !before.has(id) && !p.exempt.has(id));
  if (!added.length) return p.ids;
  const choices = await resolveChoices(db, a.ctx.accountId, p.column.settings ?? {});
  if (!choices.some((c) => c.query)) return p.ids;
  const addedTargets = p.targets.filter((t) => added.includes(t.id));
  const unmatched = new Set(await unmatchedIn(db, a, choices, addedTargets));
  if (!unmatched.size) return p.ids;
  const names = addedTargets.filter((t) => unmatched.has(t.id)).map((t) => t.name);
  if (p.policy === 'enforce')
    throw new AppError(RELATION_NOT_IN_FILTER, `Not offered by the column's filter: ${names.join(', ')}`, {
      column_id: p.column.key,
      item_ids: [...unmatched],
      names,
    });
  const note: RelationNote = {
    kind: p.policy === 'drop' ? 'relation_dropped' : 'relation_marked',
    column_key: p.column.key,
    item_id: p.itemId,
    ids: [...unmatched],
    names,
  };
  a.notes?.push(note);
  return p.policy === 'drop' ? p.ids.filter((id) => !unmatched.has(id)) : p.ids;
};

/** A relation column of a board the actor may read (404 otherwise; also when restricted from their view). */
export const loadRelationColumn = async (db: Db, a: Actor, boardId: string, key: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  const column = (await visibleColumns(db, access)).find((c) => c.key === key);
  if (!column || column.type !== 'board_relation') throw new AppError('not_found', 'Column not found');
  return column;
};

/** Page size of the relation picker. */
export const CHOICE_PAGE = 30;

/**
 * The relation picker on a filtered column (`GET /boards/:target/items/search?source_board_id=&column_id=`):
 * items of the linked board that match the column's filter, by name, for this viewer — 30 at a time — with the
 * caption ("by …") and how many name matches the filter hides. null = the board is not filtered (plain search);
 * a filter that cannot run (its view is gone) answers with every item and says so in `filter.invalid`.
 */
export const relationChoiceSearch = async (
  db: Db,
  a: Actor,
  targetBoardId: string,
  q: string,
  src: { boardId: string; columnKey: string; offset: number; ids?: string[] },
) => {
  const column = await loadRelationColumn(db, a, src.boardId, src.columnKey);
  const boards = ((column.settings ?? {}).board_ids as string[] | undefined) ?? [];
  if (!boards.includes(targetBoardId)) throw new AppError('not_found', 'Not a linked board of this column');
  const choice = (await resolveChoices(db, a.ctx.accountId, column.settings ?? {})).find(
    (c) => c.board_id === targetBoardId,
  );
  if (!choice) return null;
  const filter = { source: choice.source, view_id: choice.view_id, label: choice.label, invalid: choice.invalid };
  const query = choice.query ?? ALL;
  const page = await matchIds(db, a, targetBoardId, query, {
    ids: src.ids ?? null,
    name: q,
    offset: src.offset,
    limit: CHOICE_PAGE,
    byName: true,
  });
  const rows = new Map((await itemsByIds(db, a.ctx.accountId, page.ids)).map((r) => [r.id, r]));
  const data = page.ids.flatMap((id) => {
    const r = rows.get(id);
    return r ? [{ id: r.id, name: r.name, board_id: r.boardId, group_id: r.groupId }] : [];
  });
  // "There is a match by name, but the filter hides it" — only when the person searched.
  const hidden =
    q.trim() && choice.query && !src.ids
      ? (await matchIds(db, a, targetBoardId, ALL, { name: q, limit: 1 })).total - page.total
      : 0;
  const next = src.offset + data.length;
  return {
    data,
    filter,
    total: page.total,
    hidden_by_filter: Math.max(0, hidden),
    next_offset: next < page.total ? next : null,
  };
};

/** `GET /boards/:id/columns/:key/relation-matches` (see columnRelationMatches). */
export const relationMatches = async (db: Db, a: Actor, boardId: string, key: string) =>
  columnRelationMatches(db, a, await loadRelationColumn(db, a, boardId, key));

const same = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);

/**
 * Saving a relation column's settings (create / update): filters for boards it no longer links to are dropped;
 * each filter that CHANGED must be valid now — the saver may read that board, a view is a live shared view of
 * it, a built filter plans against its columns (unknown column / operator → 422). An unchanged filter whose
 * view was deleted since is kept as it is (the column shows "the view no longer exists").
 */
export const checkChoiceSettings = async (
  db: Db,
  a: Pick<Actor, 'ctx' | 'user' | 'requestId'>,
  settings: Record<string, unknown>,
  previous: Record<string, unknown> | null,
) => {
  const next = normalizeChoiceSettings(settings);
  const before = (previous?.choice_filter ?? {}) as Record<string, unknown>;
  for (const [boardId, f] of Object.entries(choiceFilters(next))) {
    if (same(before[boardId], f)) continue;
    const fail = (reason: string) =>
      new AppError('validation_failed', `Invalid filter for linked board ${boardId}`, { reason, board_id: boardId });
    if (f.mode === 'view') {
      const view = await findView(db, a.ctx.accountId, f.view_id);
      if (!view || view.boardId !== boardId) throw fail('view_not_found');
      if (view.visibility !== 'shared') throw fail('view_not_shared');
    }
    try {
      await prepareQuery(db, a, boardId, f.mode === 'filter' ? choiceQuery(f.filter) : ALL);
    } catch (e) {
      if (e instanceof AppError && (e.code === 'forbidden' || e.code === 'not_found')) throw fail('board_not_readable');
      throw e;
    }
  }
  return next;
};
