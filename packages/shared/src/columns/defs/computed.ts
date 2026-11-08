// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { STATUS_COLORS } from '../../colors';
import { DATE_OPS, NUMBER_COMPARE_OPS, TEXT_OPS, type Aggregate, type ColumnTypeDef } from '../types';
import { formatDateTime, formatInstantDate, type Region } from '../../locale/format';
import { formatNumberAs, numberFormatSettings, type NumberFormat } from './basic';
import { DEP_KINDS, DEP_MODES } from '../../timeline/dependencies';
import { relationFilterSettings } from '../../query/relation-filter';
import { cellLinkSchema, FILE_CELL_LINKS_MAX, fileLinkText } from '../file-links';

/**
 * Relations and computed/meta columns. Their stored settings are complete now; values are produced by later
 * epics: links + mirror refresh + formula engine (E4), files (E7). Until then they render empty / from items.
 */
export const RELATION_PICKER_GROUPINGS = ['board_group', 'board', 'none'] as const;
export type RelationPickerGrouping = (typeof RELATION_PICKER_GROUPINGS)[number];

const relationSettings = z.object({
  board_ids: z.array(z.string()).max(20),
  allow_multiple: z.boolean().optional(),
  two_way: z.boolean().optional(),
  reflection_column_id: z.string().optional(),
  /** Template references (`@contacts`) resolved when the whole template set is instantiated. */
  board_refs: z.array(z.string()).optional(),
  /** each linked item's chip shows up to this many characters (unset = by the cell's width). */
  chip_max_chars: z.number().int().min(3).max(100).optional(),
  /**
   * how the picker lists the linked boards' items — under each board's name and its groups (the
   * default), under the board's name only, or one list.
   */
  picker_group_by: z.enum(RELATION_PICKER_GROUPINGS).optional(),
  /** r19relfilter: offer only items matching a shared view / a filter, per linked board. */
  ...relationFilterSettings,
});
const relationValue = z.object({ item_ids: z.array(z.string()).max(1000) });

/** 03 §2.16 — truth lives in item_links; the cell is a cache. */
export const boardRelationColumn: ColumnTypeDef<z.infer<typeof relationSettings>, z.infer<typeof relationValue>> = {
  type: 'board_relation',
  labelHe: 'חיבור בורדים',
  category: 'relations',
  priority: 'P0',
  storage: 'cell',
  engine: 'links',
  readOnly: false,
  settingsSchema: relationSettings,
  valueSchema: relationValue,
  defaultSettings: { board_ids: [], allow_multiple: true },
  toText: (v, _s, ctx) =>
    v.item_ids
      .map((id) => ctx.itemName?.(id) ?? '')
      .filter(Boolean)
      .join(', '),
  filterOperators: [
    'any_of',
    'not_any_of',
    'contains_text',
    'is_empty',
    'is_not_empty',
    'has_unmatched_link',
    'no_unmatched_link',
  ],
  filterModel: 'links',
  sortKey: 'text',
  aggregates: ['count'],
};

const dependencySettings = z.object({
  /** strict = shift dependents the same · flexible = only on overlap · visual = arrows only (D25). */
  mode: z.enum(DEP_MODES).default('flexible'),
  /** The date / timeline column the dependency moves; unset = the board's first timeline, else first date. */
  date_column_id: z.string().max(64).optional(),
  allow_multiple: z.boolean().optional(),
});
const dependencyValue = z.object({
  item_ids: z.array(z.string()).max(200),
  /** Lag (days) per predecessor; missing = 0. */
  lag_days: z.record(z.string(), z.number().int().min(-365).max(365)).optional(),
  /** Kind per predecessor; missing = FS. */
  kind: z.record(z.string(), z.enum(DEP_KINDS)).optional(),
});

/**
 * 03 §3.2 (M8 ד7) — the items of the same board this item depends on. Truth in item_links (`meta`: kind + lag);
 * a date change of a predecessor shifts its dependents per the column's mode (server, one batch).
 */
export const dependencyColumn: ColumnTypeDef<z.infer<typeof dependencySettings>, z.infer<typeof dependencyValue>> = {
  type: 'dependency',
  labelHe: 'תלות',
  category: 'relations',
  priority: 'P1',
  storage: 'cell',
  engine: 'links',
  readOnly: false,
  settingsSchema: dependencySettings,
  valueSchema: dependencyValue,
  defaultSettings: { mode: 'flexible', allow_multiple: true },
  toText: (v, _s, ctx) =>
    v.item_ids
      .map((id) => ctx.itemName?.(id) ?? '')
      .filter(Boolean)
      .join(', '),
  filterOperators: ['any_of', 'not_any_of', 'contains_text', 'is_empty', 'is_not_empty'],
  filterModel: 'links',
  sortKey: 'text',
  aggregates: ['count'],
};

/** `relation_column_id` of a mirror that reads the item's subitems instead of a relation column (D14). */
export const MIRROR_SUBITEMS = '__subitems__';

/**
 * How a mirror of labels (status / dropdown, or a mirror of them) shows (r15cols): the joined text, a coloured chip
 * per label, or the coloured distribution bar of the group footers.
 */
export const MIRROR_DISPLAYS = ['text', 'chips', 'bar'] as const;
export type MirrorDisplay = (typeof MIRROR_DISPLAYS)[number];

const mirrorSettings = z.object({
  relation_column_id: z.string().optional(),
  source_column_id: z.string().optional(),
  aggregate: z.custom<Aggregate>().optional(),
  display: z.enum(MIRROR_DISPLAYS).optional(),
});

/** One label a mirror reads: its text, colour and on how many of the linked items it is. */
export const mirrorLabelSchema = z.object({ label: z.string(), color: z.string(), count: z.number().int().min(1) });
export type MirrorLabel = z.infer<typeof mirrorLabelSchema>;

const mirrorValue = z.object({
  display_value: z.string(),
  number: z.number().nullable().optional(),
  /** Present when the source column is a label column: the labels in the order first met, with counts. */
  labels: z.array(mirrorLabelSchema).optional(),
  /** a people source's user / team ids (filtered like a people column). */
  people: z.array(z.string()).optional(),
  /** a date source's dates, one per linked item that has one (filtered like a date column). */
  dates: z.array(z.object({ start: z.string(), end: z.string() })).optional(),
  /**
   * per linked item (one entry each, empty for an item without a value) its label texts, people and
   * dates — for filter rules that need every linked item to match. Only for label / people / date sources.
   */
  each: z
    .array(
      z.object({
        labels: z.array(z.string()).optional(),
        people: z.array(z.string()).optional(),
        dates: z.array(z.object({ start: z.string(), end: z.string() })).optional(),
      }),
    )
    .optional(),
});
/** One linked item's values in a mirror (`each`). */
export type MirrorEach = { labels?: string[]; people?: string[]; dates?: { start: string; end: string }[] };

/**
 * what a mirror reads — the type of its source column (through a mirror of a mirror: the last one)
 * and only the settings that show its numbers (unit, decimals, thousands, a duration's display). The server resolves
 * it with the board's columns; the group footers offer that type's summaries over the mirrored values and show
 * them the source's way (a currency sums as currency). a label source also brings its labels (text
 * and colour only) — the filter offers them as a status / dropdown column would. Never its formula or other settings.
 */
export const mirrorSourceSchema = z.object({ type: z.string(), settings: z.record(z.string(), z.unknown()) });
export type MirrorSource = z.infer<typeof mirrorSourceSchema>;
const MIRROR_FORMAT_KEYS = ['unit', 'precision', 'thousands', 'display', 'show_seconds'];
type SourceLabel = { id: number; label: string; color?: string; is_done?: boolean; is_deactivated?: boolean };
const sourceLabels = (labels: unknown): SourceLabel[] =>
  (Array.isArray(labels) ? (labels as SourceLabel[]) : []).map((l) => ({
    id: l.id,
    label: l.label,
    ...(l.color ? { color: l.color } : {}),
    ...(l.is_done ? { is_done: true } : {}),
    ...(l.is_deactivated ? { is_deactivated: true } : {}),
  }));
/** `withLabels`: the source is a label type (the caller knows its definition) — its labels travel too. */
export const mirrorSourceOf = (
  type: string,
  settings: Record<string, unknown>,
  opts: { withLabels?: boolean } = {},
): MirrorSource => {
  const kept = Object.fromEntries(Object.entries(settings ?? {}).filter(([k]) => MIRROR_FORMAT_KEYS.includes(k)));
  const labels = opts.withLabels ? sourceLabels(settings?.labels) : [];
  return { type, settings: labels.length ? { ...kept, labels } : kept };
};

/** A label's colour: a status label's own; a dropdown label (no colour) a stable one of the status palette. */
export const labelColor = (label: { id: number; color?: string }): string =>
  label.color ?? STATUS_COLORS[label.id % STATUS_COLORS.length]!;

/**
 * 03 §2.17 — values of `source_column_id` on the items linked through `relation_column_id`, aggregated
 * (numbers: `aggregate`, default sum; others: joined text). Computed on read; read-only through the API.
 */
export const mirrorColumn: ColumnTypeDef<z.infer<typeof mirrorSettings>, z.infer<typeof mirrorValue>> = {
  type: 'mirror',
  labelHe: 'מראה',
  category: 'relations',
  priority: 'P0',
  storage: 'computed',
  engine: 'mirror',
  readOnly: true,
  settingsSchema: mirrorSettings,
  valueSchema: mirrorValue,
  defaultSettings: {},
  toText: (v) => v.display_value,
  toNumber: (v) => v.number ?? null,
  toFormula: (v) => v.number ?? v.display_value,
  // Its text and number; with a known source the filter offers that source type's operators instead (prod
  // `mirrorFilterOf`, query/mirror-filter.ts).
  filterOperators: [...TEXT_OPS, ...NUMBER_COMPARE_OPS],
  filterModel: 'text',
  sortKey: 'text',
  aggregates: [],
};

/** A formula shows a number result the way a numbers column would (unit, fixed decimals, 1,000s — 03 §2.18). */
const formulaSettings = numberFormatSettings.extend({
  formula: z.string().max(10000),
  result_type: z.enum(['auto', 'number', 'text', 'date', 'boolean']).optional(),
  /**
   * Fix: — a result that is a web address shows as a link: `auto` (default) when the whole result is an
   * http(s) URL, `on` also for a bare domain ("example.com/x" → https://), `off` never.
   */
  show_as_link: z.enum(['auto', 'on', 'off']).optional(),
});

/** A host with a dot and a known shape (`example.co.il`, `sub.example.com:8080`) — for bare domains under `on`. */
const BARE_DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/**
 * The safe link of a formula result, or null: only http / https (never javascript:, data:, mailto: …), one address
 * with no spaces, at most 2000 characters, parsed by URL. Shown with rel="noopener noreferrer".
 */
export const formulaHref = (result: unknown, settings: { show_as_link?: 'auto' | 'on' | 'off' }): string | null => {
  const mode = settings.show_as_link ?? 'auto';
  if (mode === 'off' || typeof result !== 'string') return null;
  const v = result.trim();
  if (!v || v.length > 2000 || /\s/.test(v)) return null;
  const candidate = /^https?:\/\//i.test(v) ? v : mode === 'on' && BARE_DOMAIN_RE.test(v) ? `https://${v}` : null;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url.href : null;
  } catch {
    return null;
  }
};

/** A formula's number as text: its column's number format; without fixed decimals, rounded to 2 (as before). */
export const formatFormulaNumber = (n: number, s: NumberFormat): string =>
  formatNumberAs(s.precision !== undefined && s.precision >= 0 ? n : Math.round(n * 100) / 100, s);

/** 03 §2.18 — evaluated by packages/shared/formula (E4), stored denormalised so it can be filtered and sorted. */
export const formulaColumn: ColumnTypeDef<
  z.infer<typeof formulaSettings>,
  { result: string | number | boolean | null }
> = {
  type: 'formula',
  labelHe: 'נוסחה',
  category: 'computed',
  priority: 'P0',
  storage: 'computed',
  engine: 'formula',
  readOnly: true,
  settingsSchema: formulaSettings,
  valueSchema: z.object({ result: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
  defaultSettings: { formula: '' },
  toText: (v, s) =>
    typeof v.result === 'number' ? formatFormulaNumber(v.result, s) : v.result === null ? '' : String(v.result),
  toNumber: (v) => (typeof v.result === 'number' ? v.result : null),
  toFormula: (v) => v.result,
  // Footers, mirrors of the formula, dashboards: the formula's own number format.
  formatNumber: (n, s) => formatFormulaNumber(n, s),
  filterOperators: [...TEXT_OPS, ...NUMBER_COMPARE_OPS],
  filterModel: 'text',
  sortKey: 'text',
  aggregates: ['sum', 'avg', 'count'],
};

/** An item number's prefix (03 §2.19): optional — empty shows just the (padded) number: 1, 2, … 324. */
export const ITEM_KEY_PREFIX_RE = /^[A-Za-z0-9-]{0,10}$/;

const itemIdSettings = z.object({
  display: z.enum(['id', 'custom_key']),
  prefix: z.string().regex(ITEM_KEY_PREFIX_RE).optional(),
  padding: z.number().int().min(1).max(8).optional(),
});

/**
 * 03 §2.19 — `{key}` computed from items.key_seq + item_keys. `custom_key` keeps a running number per board
 * (created with the column, existing items numbered in creation order); a new column starts as a plain number.
 */
export const itemIdColumn: ColumnTypeDef<z.infer<typeof itemIdSettings>, { key: string }> = {
  type: 'item_id',
  labelHe: 'מזהה פריט',
  category: 'meta',
  priority: 'P0',
  storage: 'computed',
  readOnly: true,
  settingsSchema: itemIdSettings,
  valueSchema: z.object({ key: z.string() }),
  defaultSettings: { display: 'custom_key', prefix: '', padding: 1 },
  fromItem: (item) => ({ key: item.key ?? item.id }),
  toText: (v) => v.key,
  // Sorts by the running number (PRJ-0009 before PRJ-0010; 9 before 10).
  toNumber: (v) => {
    const m = /^[A-Za-z0-9-]{0,10}?(\d{1,12})$/.exec(v.key);
    return m ? Number(m[1]) : null;
  },
  filterOperators: ['contains_text', 'any_of'],
  filterModel: 'text',
  sortKey: 'number',
  aggregates: [],
};

/** What a creation-log / last-updated column shows (03 §2.21–2.22): who and when (default), only when, only who. */
export const META_LOG_MODES = ['both', 'date', 'person'] as const;
export type MetaLogMode = (typeof META_LOG_MODES)[number];
/** Display settings of both meta columns: what to show and whether "when" includes the time of day (r23ui). */
export type MetaLogDisplay = { mode?: MetaLogMode | 'ago'; show_time?: boolean };
export type MetaLogValue = { at: string; by: string | null };

/**
 * The text of a creation-log / last-updated cell: "Dana · 05/10/2026 14:05". `ago` is the setting of last-updated
 * columns made before r23ui — shown as the date, as it always was. Without a region: the canonical text (UTC).
 */
export const metaLogText = (
  v: MetaLogValue,
  s: MetaLogDisplay,
  ctx: { region?: Region; userName?: (id: string) => string | undefined },
): string => {
  const date = ctx.region
    ? s.show_time
      ? formatDateTime(v.at, {}, ctx.region)
      : formatInstantDate(v.at, {}, ctx.region)
    : `${v.at.slice(8, 10)}/${v.at.slice(5, 7)}/${v.at.slice(0, 4)}${s.show_time ? ` ${v.at.slice(11, 16)}` : ''}`;
  const who = (v.by && ctx.userName?.(v.by)) || '';
  const mode = s.mode === 'ago' ? 'date' : (s.mode ?? 'both');
  if (mode === 'date') return date;
  if (mode === 'person') return who;
  return who ? `${who} · ${date}` : date;
};

const metaValueSchema = z.object({ at: z.string(), by: z.string().nullable() });

/** 03 §2.21 — from items.created_by / created_at. */
export const creationLogColumn: ColumnTypeDef<{ mode?: MetaLogMode; show_time?: boolean }, MetaLogValue> = {
  type: 'creation_log',
  labelHe: 'יומן יצירה',
  category: 'meta',
  priority: 'P0',
  storage: 'computed',
  readOnly: true,
  settingsSchema: z.object({ mode: z.enum(META_LOG_MODES).optional(), show_time: z.boolean().optional() }),
  valueSchema: metaValueSchema,
  defaultSettings: { mode: 'both' },
  fromItem: (item) => ({ at: item.createdAt, by: item.createdBy }),
  // 03 §2.21: who and when (default), only the date, or only who.
  toText: (v, s, ctx) => metaLogText(v, s, ctx),
  toDate: (v) => v.at,
  // Every date operator except empty / not empty: every item has a creation time, so "is empty"
  // could never match — the builder does not offer it, and a saved rule with it is shown as invalid and skipped.
  filterOperators: DATE_OPS.filter((op) => op !== 'is_empty' && op !== 'is_not_empty'),
  filterModel: 'date',
  sortKey: 'date',
  aggregates: [],
};

export type LastUpdatedSettings = {
  /** `ago`: the setting of columns made before r23ui (shown as the date). */
  mode?: MetaLogMode | 'ago';
  show_time?: boolean;
  /**
   * r23ui (a "last modified time" column of specific fields): only changes of these columns (keys) count.
   * Empty / absent = a change of any cell of the item.
   */
  columns?: string[];
};

/**
 * The last change a last-updated column shows: the item's last cell change, or — with `columns` — the latest change
 * of one of those columns (`changeOf`: a column key's last change on this item, see the API's Calculator). None of
 * them ever changed = null (an empty cell).
 */
export const lastUpdatedValue = (
  s: LastUpdatedSettings,
  item: { lastChangeAt: string; lastChangeBy: string | null },
  changeOf?: (columnKey: string) => MetaLogValue | undefined,
): MetaLogValue | null => {
  if (!s.columns?.length) return { at: item.lastChangeAt, by: item.lastChangeBy };
  let best: MetaLogValue | null = null;
  for (const key of s.columns) {
    const c = changeOf?.(key);
    if (c && (!best || Date.parse(c.at) > Date.parse(best.at))) best = c;
  }
  return best;
};

/** 03 §2.22 — from items.last_cell_change_at / _by, or the last change of chosen columns (r23ui). */
export const lastUpdatedColumn: ColumnTypeDef<LastUpdatedSettings, MetaLogValue> = {
  type: 'last_updated',
  labelHe: 'עודכן לאחרונה',
  category: 'meta',
  priority: 'P0',
  storage: 'computed',
  readOnly: true,
  settingsSchema: z.object({
    mode: z.enum([...META_LOG_MODES, 'ago']).optional(),
    show_time: z.boolean().optional(),
    columns: z.array(z.string().max(64)).max(50).optional(),
  }),
  valueSchema: metaValueSchema,
  defaultSettings: { mode: 'both' },
  fromItem: (item, s) => lastUpdatedValue(s ?? {}, item, item.columnChange),
  toText: (v, s, ctx) => metaLogText(v, s, ctx),
  toDate: (v) => v.at,
  // Every date operator (s4f: automation conditions such as "more than N days ago" read this column itself); empty
  // when none of its chosen columns ever changed.
  filterOperators: DATE_OPS,
  filterModel: 'date',
  sortKey: 'date',
  aggregates: [],
};

const fileValue = z.object({
  files: z
    .array(
      z.object({
        asset_id: z.string(),
        name: z.string(),
        size: z.number(),
        mime: z.string(),
        version: z.number().int(),
        added_by: z.string(),
        added_at: z.string(),
      }),
    )
    .max(100),
  /** Docs made in the cell (Fix: , "new doc" in a files column): written by the docs API. */
  docs: z
    .array(z.object({ doc_id: z.string(), name: z.string() }))
    .max(100)
    .optional(),
  /** Web links kept in the cell — written by the links endpoints. */
  links: z.array(cellLinkSchema).max(FILE_CELL_LINKS_MAX).optional(),
});

/** 03 §2.15 — written through the files endpoints (E7), not by setting the cell directly. */
export const fileColumn: ColumnTypeDef<{ max_files?: number; image_previews?: boolean }, z.infer<typeof fileValue>> = {
  type: 'file',
  labelHe: 'קבצים',
  category: 'essentials',
  priority: 'P0',
  storage: 'cell',
  engine: 'files',
  readOnly: false, // written through the files endpoints (engine 'files'), not PUT /cells
  settingsSchema: z.object({
    max_files: z.number().int().min(1).optional(),
    /** images show as small previews in the cell (on unless turned off). */
    image_previews: z.boolean().optional(),
  }),
  valueSchema: fileValue,
  defaultSettings: {},
  toText: (v) =>
    [...v.files.map((f) => f.name), ...(v.docs ?? []).map((d) => d.name), ...(v.links ?? []).map(fileLinkText)].join(
      ', ',
    ),
  filterOperators: ['is_empty', 'is_not_empty', 'contains_text'],
  filterModel: 'files',
  sortKey: 'none',
  aggregates: ['count'],
};
