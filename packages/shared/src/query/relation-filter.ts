// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { FilterOperator } from '../columns/types';
import { filterGroupSchema, flattenRules, isGroup, querySchema, type FilterGroup, type Query } from './filter';

/**
 * Relation filters (the planning notes "RELATION-FILTERS", r19relfilter): a board_relation column offers, per linked
 * board, only the items that match a saved shared view of that board or a filter built in the column. A linked
 * item that stops matching is never unlinked — it is marked "does not match" (computed per viewer, never stored).
 */
export const choiceFilterSchema = z.discriminatedUnion('mode', [
  /** A live link to a shared view of the linked board: its filter / search / person. */
  z.object({ mode: z.literal('view'), view_id: z.string().min(1).max(40) }),
  /** A filter built in the column (the board filter's editor, on the linked board's columns). */
  z.object({ mode: z.literal('filter'), filter: filterGroupSchema }),
]);
export type ChoiceFilter = z.infer<typeof choiceFilterSchema>;

/** The relation column's settings for it (merged into board_relation's settings schema). */
export const relationFilterSettings = {
  /** Linked board id → its filter. A board left out offers every item (as before). */
  choice_filter: z.record(z.string().max(40), choiceFilterSchema).optional(),
  /** The cell shows only matching links (+N hidden); the links themselves stay. Default off. */
  only_matching_in_cell: z.boolean().optional(),
  /** New links from the API / MCP must match too (`relation_not_in_filter`). Default on. */
  choice_filter_api: z.boolean().optional(),
  /** A short text above the picker's list (default: the view's name / "by filter"). */
  choice_caption: z.string().max(120).optional(),
};

/** The board_relation filter operators that read the column's choice filter (no values). */
export const RELATION_MATCH_OPS = ['has_unmatched_link', 'no_unmatched_link'] as const satisfies FilterOperator[];
export const isRelationMatchOp = (op: string): op is (typeof RELATION_MATCH_OPS)[number] =>
  (RELATION_MATCH_OPS as readonly string[]).includes(op);

type Settings = Record<string, unknown> | null | undefined;

/** The column's filters per linked board (only boards it still links to). */
export const choiceFilters = (settings: Settings): Record<string, ChoiceFilter> => {
  const raw = settings?.choice_filter;
  if (!raw || typeof raw !== 'object') return {};
  const boards = new Set(Array.isArray(settings?.board_ids) ? (settings.board_ids as string[]) : []);
  const out: Record<string, ChoiceFilter> = {};
  for (const [boardId, f] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = choiceFilterSchema.safeParse(f);
    if (parsed.success && boards.has(boardId) && !isEmptyChoice(parsed.data)) out[boardId] = parsed.data;
  }
  return out;
};

export const choiceFilterOf = (settings: Settings, boardId: string): ChoiceFilter | null =>
  choiceFilters(settings)[boardId] ?? null;

/** Whether the column narrows its picker on any linked board. */
export const hasChoiceFilter = (settings: Settings) => Object.keys(choiceFilters(settings)).length > 0;

/** A filter without rules narrows nothing — the same as none. */
export const isEmptyChoice = (f: ChoiceFilter) => f.mode === 'filter' && flattenRules(f.filter).length === 0;

/** The server enforces the filter on new links from the API / MCP (default on). */
export const enforcesChoiceFilter = (settings: Settings) => settings?.choice_filter_api !== false;

/**
 * A choice filter never reads other relations' marks ("has a link that does not match"): that could loop
 * between two boards' columns. Such rules are dropped.
 */
export const withoutMatchRules = (g: FilterGroup): FilterGroup => ({
  ...g,
  rules: g.rules
    .filter((r) => isGroup(r) || !isRelationMatchOp(r.operator))
    .map((r) => (isGroup(r) ? withoutMatchRules(r) : r)),
});

/** A column filter as the query it runs (views resolve on the server: their saved query). */
export const choiceQuery = (filter: FilterGroup): Query => querySchema.parse({ filter: withoutMatchRules(filter) });

/** The query of a saved view as a choice filter: what it narrows, never how it sorts or groups. */
export const viewChoiceQuery = (q: Query): Query => ({
  ...q,
  filter: q.filter ? withoutMatchRules(q.filter) : undefined,
  sort: [],
  group_by: undefined,
  scope: 'all',
});

/**
 * The settings as they are saved: filters only for boards the column links to (a board taken off the list
 * takes its filter with it), and no empty filters. The rest (views, columns) is checked on the server.
 */
export const normalizeChoiceSettings = <T extends Record<string, unknown>>(settings: T): T => {
  if (!('choice_filter' in settings)) return settings;
  const kept = choiceFilters(settings);
  const { choice_filter: _drop, ...rest } = settings;
  return (Object.keys(kept).length ? { ...rest, choice_filter: kept } : rest) as unknown as T;
};

/** Error code of a new link that does not match the column's filter. */
export const RELATION_NOT_IN_FILTER = 'relation_not_in_filter';

// ---- API (r19relfilter) ----

const choiceInfoSchema = z.object({
  source: z.enum(['view', 'filter']),
  view_id: z.string().nullable(),
  /** The caption: the column's text, else the view's name; null = "by filter". */
  label: z.string().nullable(),
  /** `view_missing`: the view was deleted or made private — the board offers every item until a new choice. */
  invalid: z.enum(['view_missing']).nullable(),
});

/** `GET /boards/:id/items/search` — the relation picker; `filter` etc. only with `source_board_id` + `column_id`. */
export const itemSearchResultSchema = z.object({
  /** `group_id`: the picker shows the items under their board's groups. */
  data: z.array(
    z.object({ id: z.string(), name: z.string(), board_id: z.string(), group_id: z.string().nullable().optional() }),
  ),
  filter: choiceInfoSchema.nullable().optional(),
  total: z.number().int().optional(),
  /** Items whose name matches the search but that the filter does not offer. */
  hidden_by_filter: z.number().int().optional(),
  next_offset: z.number().int().nullable().optional(),
});
export type ItemSearchResult = z.infer<typeof itemSearchResultSchema>;

/** `GET /boards/:id/columns/:key/relation-matches` — per viewer, never stored. */
export const relationMatchesSchema = z.object({
  filters: z.array(choiceInfoSchema.extend({ board_id: z.string() })),
  only_matching_in_cell: z.boolean(),
  /** Linked items (any row of the board) that the viewer may see and that do not match their board's filter. */
  unmatched: z.array(z.string()),
  /** More linked items than one pass checks (5000): the rest are not marked. */
  truncated: z.boolean(),
});
export type RelationMatches = z.infer<typeof relationMatchesSchema>;

// ---- copies (r19relfilter leftovers): a board copied together with its linked board ----

/**
 * How a copy maps what a choice filter names. `board`: a board that was copied together → its copy (or a template
 * ref such as `@self`); a board it does not know stays (the filter keeps pointing at the original). `view`: the
 * copied shared views. `column`: a column key of a copied board → the copy's key (copies keep their keys: absent =
 * the same key). `group`: copied groups (the `__group__` rule's values).
 */
export type ChoiceRemap = {
  board: (id: string) => string | undefined;
  view?: (id: string) => string | undefined;
  column?: (boardId: string, key: string) => string | undefined;
  group?: (id: string) => string | undefined;
};

const remapRules = (g: FilterGroup, boardId: string, m: ChoiceRemap): FilterGroup => ({
  ...g,
  rules: g.rules.map((r) => {
    if (isGroup(r)) return remapRules(r, boardId, m);
    if (r.column_id === '__group__' && m.group)
      return { ...r, values: r.values.map((v) => (typeof v === 'string' ? (m.group!(v) ?? v) : v)) };
    if (r.column_id.startsWith('__')) return r;
    return { ...r, column_id: m.column?.(boardId, r.column_id) ?? r.column_id };
  }),
});

/**
 * A relation column's settings on a copy: the linked boards that were copied too become their copies (`board_ids`
 * and the `choice_filter` keys), a view filter points at the copied view, and a built filter's columns / groups at
 * the copy's. A view that was not copied keeps its id (the column then says "the view no longer exists").
 */
export const remapChoiceSettings = <T extends Record<string, unknown>>(settings: T, m: ChoiceRemap): T => {
  const out: Record<string, unknown> = { ...settings };
  if (Array.isArray(settings.board_ids))
    out.board_ids = [...new Set((settings.board_ids as string[]).map((id) => m.board(id) ?? id))];
  const raw = settings.choice_filter;
  if (raw && typeof raw === 'object') {
    const next: Record<string, unknown> = {};
    for (const [boardId, f] of Object.entries(raw as Record<string, unknown>)) {
      const to = m.board(boardId);
      const parsed = choiceFilterSchema.safeParse(f);
      if (!to || !parsed.success) {
        next[to ?? boardId] = f;
        continue;
      }
      const c = parsed.data;
      next[to] =
        c.mode === 'view'
          ? { mode: 'view', view_id: m.view?.(c.view_id) ?? c.view_id }
          : { mode: 'filter', filter: remapRules(c.filter, boardId, m) };
    }
    out.choice_filter = next;
  }
  return out as T;
};
