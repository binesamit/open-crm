// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { filterGroupSchema, MAX_SORT_LEVELS, sortLevelSchema, type FilterGroup, type SortLevel } from '../query/filter';
import { SUMMARY_FNS, type SummaryFn } from '../query/summary';

/**
 * Item card tabs (N19, M7.6): set per board through the UI (`boards.settings.card`). "Updates" is fixed — always
 * first and always shown; every other tab can be hidden, renamed and reordered, and "fields" tabs (the board's
 * columns as a form) may repeat, each with its own columns in its own order.
 */
export const CARD_TAB_TYPES = ['updates', 'fields', 'subitems', 'time', 'activity', 'documents'] as const;
export type CardTabType = (typeof CARD_TAB_TYPES)[number];

export const cardTabSchema = z.object({
  /** Stable id within the board: the type for the single tabs, any short id for extra "fields" tabs. */
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,23}$/)
    .max(24),
  type: z.enum(CARD_TAB_TYPES),
  /** Shown name; empty / missing = the type's default name. */
  title: z.string().trim().max(40).optional(),
  hidden: z.boolean().default(false),
  /** "fields" tab: the column keys shown, in this order; missing = every column in the board's order. */
  columns: z.array(z.string().max(64)).max(500).optional(),
});
export type CardTab = z.infer<typeof cardTabSchema>;

/**
 * How the card shows the item's subitems (cardsub): in the "Subitems" tab and as a table under the item's own
 * fields in the main "Fields" tab. The card opens with `view_id` (a saved view of the sub-board — its columns,
 * filter, sort and footer) or, without one, the subitems tab's columns; `filter` / `sort` refine that default and
 * `summaries` choose each column's footer calculation (else the view's choice, else the type's default).
 */
export const cardSubitemsSchema = z.object({
  /** The subitems table under the item's fields in the main "Fields" tab. */
  in_fields: z.boolean().default(true),
  /** A saved view of the sub-board the card starts with; missing = the card's own columns. */
  view_id: z.string().max(64).optional(),
  /** Replaces the view's filter; missing = the view's (none without a view). */
  filter: filterGroupSchema.optional(),
  /** Replaces the view's sort when not empty. */
  sort: z.array(sortLevelSchema).max(MAX_SORT_LEVELS).default([]),
  show_summary: z.boolean().default(true),
  /** Footer calculation per sub-board column (`summaryOptions`). */
  summaries: z.record(z.string().max(64), z.enum(SUMMARY_FNS)).default({}),
});
export type CardSubitems = z.infer<typeof cardSubitemsSchema>;

/**
 * r15: how many fields stand side by side in the card's "Fields" tabs — 1 (a label next to each field, as
 * before), 2 or 3 (label above), or `auto` (as many as fit the card's width). Narrow cards step down by
 * themselves and a phone always shows one per row.
 */
export const CARD_FIELDS_PER_ROW = [1, 2, 3, 'auto'] as const;
export type CardFieldsPerRow = (typeof CARD_FIELDS_PER_ROW)[number];
export const cardFieldsPerRowSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal('auto')]);

export const itemCardSettingsSchema = z.object({
  tabs: z.array(cardTabSchema).max(20).default([]),
  subitems: cardSubitemsSchema.optional(),
  /** Missing = 1. */
  fields_per_row: cardFieldsPerRowSchema.optional(),
});
export type ItemCardSettings = z.infer<typeof itemCardSettingsSchema>;

/** The card's fields per row with its default (1). */
export const cardFieldsPerRowOf = (settings: unknown): CardFieldsPerRow => {
  const raw = settings && typeof settings === 'object' ? (settings as { fields_per_row?: unknown }).fields_per_row : 1;
  const parsed = cardFieldsPerRowSchema.safeParse(raw);
  return parsed.success ? parsed.data : 1;
};

/**
 * the fields per row of a card that may belong to a subitems board. A subitems board without its own
 * setting follows its parent board's (set in an item's card, it applies to its subitems' cards too); its own setting,
 * 1 included, wins.
 */
export const cardFieldsPerRowFor = (settings: unknown, parentSettings?: unknown): CardFieldsPerRow => {
  const own =
    settings && typeof settings === 'object' ? (settings as { fields_per_row?: unknown }).fields_per_row : undefined;
  return own === undefined && parentSettings !== undefined
    ? cardFieldsPerRowOf(parentSettings)
    : cardFieldsPerRowOf(settings);
};

const SINGLE: CardTabType[] = ['updates', 'subitems', 'time', 'activity', 'documents'];

/**
 * The card's tabs in order: "updates" first (never hidden, never renamed away), then the board's saved tabs,
 * then any built-in tab the board has not listed yet (new boards: updates, fields, subitems, time, activity).
 * Repeated single tabs are dropped; at most one tab per id.
 */
export const resolveCardTabs = (settings: unknown): CardTab[] => {
  const parsed = itemCardSettingsSchema.safeParse(settings ?? {});
  const saved = parsed.success ? parsed.data.tabs : [];
  const ids = new Set<string>();
  const types = new Set<CardTabType>();
  const out: CardTab[] = [{ id: 'updates', type: 'updates', hidden: false }];
  ids.add('updates');
  types.add('updates');
  for (const t of saved) {
    if (ids.has(t.id) || (SINGLE.includes(t.type) && types.has(t.type))) continue;
    ids.add(t.id);
    types.add(t.type);
    out.push(t);
  }
  // Interactive documents: the item's shared documents — last, hideable like the others.
  for (const type of ['fields', 'subitems', 'time', 'activity', 'documents'] as const) {
    if (types.has(type) || ids.has(type)) continue;
    ids.add(type);
    types.add(type);
    out.push({ id: type, type, hidden: false });
  }
  return out;
};

/** The card's subitem settings with defaults (invalid / missing settings = the defaults). */
export const cardSubitemsOf = (settings: unknown): CardSubitems => {
  const raw =
    (settings && typeof settings === 'object' ? (settings as { subitems?: unknown }).subitems : undefined) ?? {};
  const parsed = cardSubitemsSchema.safeParse(raw);
  return parsed.success ? parsed.data : cardSubitemsSchema.parse({});
};

/** How many sub-board columns the card shows when nothing chose them. */
export const CARD_SUBITEM_DEFAULT_COLUMNS = 4;

/** The parts of a saved view the card reads (a sub-board view). */
export type CardSubitemsView = {
  id: string;
  settings: {
    query: { filter?: FilterGroup; sort: SortLevel[]; search?: string; person?: string };
    hidden_columns: string[];
    column_order: string[];
    show_summary: boolean;
    summaries: Partial<Record<string, SummaryFn>>;
  };
};

/** What the card's subitems table shows. */
export type ResolvedCardSubitems = {
  inFields: boolean;
  /** The saved view in effect (null = the card's own columns). */
  viewId: string | null;
  /** Sub-board column ids, in order. */
  columns: string[];
  filter: FilterGroup | undefined;
  sort: SortLevel[];
  search: string | undefined;
  person: string | undefined;
  showSummary: boolean;
  summaries: Partial<Record<string, SummaryFn>>;
};

/** A change made in the card for this visit only (filter `null` = cleared; columns = the shown ones, in order). */
export type CardSubitemsDraft = { filter?: FilterGroup | null; sort?: SortLevel[]; columns?: string[] };

/**
 * Resolves what the card's subitems table shows (cardsub):
 * - `picked` — the view chosen in the card: `undefined` = the card's default (its `view_id` when that view still
 *   exists, refined by the card's `filter` / `sort`), `null` = the card's own columns without a view, an id = that
 *   saved view as it is.
 * - columns: the view's order minus its hidden columns; without a view the tab's `columns`, else the first few.
 * - summaries: the card's choice per column, else the view's; `draft` (ad-hoc columns / filter / sort) wins.
 */
export const resolveCardSubitems = (input: {
  card: unknown;
  /** The sub-board's columns (not the name), in board order. */
  allColumns: string[];
  /** The subitems tab's chosen columns (`CardTab.columns`). */
  tabColumns?: string[];
  views: CardSubitemsView[];
  picked?: string | null;
  draft?: CardSubitemsDraft;
}): ResolvedCardSubitems => {
  const card = cardSubitemsOf(input.card);
  const isDefault = input.picked === undefined;
  const viewId = isDefault ? card.view_id : (input.picked ?? undefined);
  const view = viewId ? (input.views.find((v) => v.id === viewId) ?? null) : null;
  const all = input.allColumns;

  let columns: string[];
  if (view) {
    const order = view.settings.column_order;
    const at = new Map(order.map((id, i) => [id, i]));
    const listed = all.filter((id) => at.has(id)).sort((a, b) => at.get(a)! - at.get(b)!);
    columns = [...listed, ...all.filter((id) => !at.has(id))].filter(
      (id) => !view.settings.hidden_columns.includes(id),
    );
  } else if (input.tabColumns) {
    columns = input.tabColumns.filter((id) => all.includes(id));
  } else {
    columns = all.slice(0, CARD_SUBITEM_DEFAULT_COLUMNS);
  }

  if (input.draft?.columns) columns = input.draft.columns.filter((id) => all.includes(id));

  let filter = view?.settings.query.filter;
  let sort = view?.settings.query.sort ?? [];
  if (isDefault) {
    if (card.filter) filter = card.filter;
    if (card.sort.length) sort = card.sort;
  }
  if (input.draft?.filter !== undefined) filter = input.draft.filter ?? undefined;
  if (input.draft?.sort) sort = input.draft.sort;

  return {
    inFields: card.in_fields,
    viewId: view?.id ?? null,
    columns,
    filter: filter && filter.rules.length ? filter : undefined,
    sort,
    search: view?.settings.query.search?.trim() || undefined,
    person: view?.settings.query.person || undefined,
    showSummary: card.show_summary && (view ? view.settings.show_summary : true),
    summaries: { ...(view?.settings.summaries ?? {}), ...card.summaries },
  };
};

/**
 * "Save as the card's default": the view picked in the card (none = the card's own columns) plus the ad-hoc
 * filter / sort. Without a draft the view's own filter and sort stay in charge (nothing copied), so later changes
 * to the view still reach the card.
 */
export const saveCardSubitemsDefault = (
  card: CardSubitems,
  picked: string | null | undefined,
  draft: CardSubitemsDraft,
): CardSubitems => {
  const isDefault = picked === undefined;
  const viewId = isDefault ? card.view_id : (picked ?? undefined);
  const filter = draft.filter !== undefined ? (draft.filter ?? undefined) : isDefault ? card.filter : undefined;
  const sort = draft.sort ?? (isDefault ? card.sort : []);
  const { view_id: _v, filter: _f, ...rest } = card;
  return {
    ...rest,
    ...(viewId ? { view_id: viewId } : {}),
    ...(filter && filter.rules.length ? { filter } : {}),
    sort,
  };
};
