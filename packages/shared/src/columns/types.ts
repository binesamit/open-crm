// SPDX-License-Identifier: AGPL-3.0-only
import type { Region } from '../locale/format';
import type { z } from 'zod';
import type { TextCtx } from './text-ctx';

/** 03-COLUMN-TYPES §1. Every column type is one module implementing this; nothing switches on `type` elsewhere. */
export type FilterOperator =
  | 'any_of'
  | 'not_any_of'
  | 'is_empty'
  | 'is_not_empty'
  | 'contains_text'
  | 'not_contains_text'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'greater_than_or_equal'
  | 'lower_than'
  | 'lower_than_or_equal'
  | 'between'
  | 'within_the_last'
  | 'within_the_next'
  | 'is_done'
  | 'is_not_done'
  /** board_relation with a choice filter (r19relfilter): a linked item no longer matches / none does. */
  | 'has_unmatched_link'
  | 'no_unmatched_link'
  /** time_tracking: a timer runs on the cell now / none does. */
  | 'is_running'
  | 'is_not_running';

/**
 * Filter semantics shared by several types (13-FILTERS §2): text (display text), number, date (start/end),
 * label (status: one label id), labels (dropdown: label ids), people (user/team ids), checkbox, links (item ids
 * + names), files (presence + names) and tags (account tag ids). The query engine knows these few models, never
 * individual types.
 */
export type FilterModel =
  'text' | 'number' | 'date' | 'label' | 'labels' | 'people' | 'checkbox' | 'links' | 'files' | 'tags';

export type Aggregate =
  | 'sum'
  | 'avg'
  | 'median'
  | 'min'
  | 'max'
  | 'count'
  | 'count_done'
  | 'done_pct'
  | 'earliest'
  | 'latest'
  | 'range'
  | 'labels';

export type ColumnCategory = 'essentials' | 'super_useful' | 'relations' | 'computed' | 'meta' | 'advanced';

/** Where the value lives: a `cells` row, the `items` row itself (name), or computed on read / by the worker. */
export type ColumnStorage = 'cell' | 'item' | 'computed';

/** Context for toText & friends: resolves ids to display names (people, linked items). */
export type ColumnCtx = {
  userName?: (id: string) => string | undefined;
  itemName?: (id: string) => string | undefined;
  /** Account tags (03 §3.1). */
  tagName?: (id: string) => string | undefined;
  locale?: 'he' | 'en';
  /**
   * The reader's region (A3): dates are written in its format and zone. Without it (the stored `text_value`,
   * written once for search and sorting) a canonical DD/MM/YYYY in UTC is used.
   */
  region?: Region;
  /** The account's country (`locale.country`): the last fallback of values that depend on one (phone E.164). */
  country?: string;
};

/**
 * The account's defaults for new columns (account settings `defaults`, Administration → General). Every key is
 * optional: without the account's settings a new column gets the built-in default.
 */
export type NewColumnDefaults = {
  /** A new numbers column shows a thousands separator; unset = on. */
  number_thousands?: boolean;
};

export interface ColumnTypeDef<S = unknown, V = unknown> {
  type: string;
  labelHe: string;
  category: ColumnCategory;
  priority: 'P0' | 'P1' | 'P2';
  storage: ColumnStorage;
  /**
   * Values that come from an engine rather than a plain cell write: item_links (relations), mirror, formula, files,
   * time entries, votes (one per user, through the vote endpoint), a doc in the cell (its own endpoint), progress
   * (computed on read from status columns), a button (no value: a click runs the column's action) or a secret
   * (encrypted outside `cells`, through the secret endpoints; the cell is only a "has a value" marker) or a signature
   * (written by signing an interactive document; the evidence lives in `idoc_signatures`).
   */
  engine?:
    'links' | 'mirror' | 'formula' | 'files' | 'time' | 'vote' | 'doc' | 'progress' | 'button' | 'secret' | 'signature';
  /** Read-only through the API (computed/meta). */
  readOnly: boolean;
  settingsSchema: z.ZodType<S>;
  valueSchema: z.ZodType<V>;
  defaultSettings: S;
  /**
   * Settings keys a NEW column of this type writes from the account's defaults for new columns (
   * a numbers column's thousands separator). Written on the column when it is made, never read as a fallback, so
   * columns made before (key unset) keep their look. See `withNewColumnDefaults`.
   */
  newColumnSettings?(defaults: NewColumnDefaults): Partial<S>;
  toText(value: V, settings: S, ctx: ColumnCtx): string;
  /**
   * The text depends on the reader's region (dates): the stored `text_value` is canonical, and reads re-derive the
   * text with `ctx.region` (items DTO, exports, automations).
   */
  localizedText?: boolean;
  toNumber?(value: V, settings: S): number | null;
  /** ISO date (YYYY-MM-DD or full ISO) for date_value. */
  toDate?(value: V, settings: S): string | null;
  toDateEnd?(value: V, settings: S): string | null;
  /**
   * Derived keys kept inside the stored value, recomputed on every write (phone: `e164` + `valid`). Whatever the
   * client sent for them is replaced. See `DERIVED_VALUE_KEYS`.
   */
  normalize?(value: V, settings: S, ctx: ColumnCtx): V;
  /** Settings keys `normalize` reads: when one changes, the column's stored values are normalised again. */
  normalizeSettingsKeys?: string[];
  /** Value-level checks that need settings (e.g. status index exists). */
  validate?(value: V, settings: S): string | null;
  filterOperators: FilterOperator[];
  /** How the query engine (13-FILTERS) reads this type's value: which semantics `filterOperators` have. */
  filterModel: FilterModel;
  sortKey: 'text' | 'number' | 'date' | 'none';
  aggregates: Aggregate[];
  /** Shows a numeric aggregate (group footer sum/avg) the way a cell would: unit, precision, duration. */
  formatNumber?(n: number, settings: S): string;
  /** Value a formula sees for `{column}` (03 §2.18); default = toText. Timelines expose {start,end}. */
  toFormula?(value: V, settings: S, ctx: ColumnCtx): FormulaInput;
  /** Meta columns computed from the item row itself (item_id, creation_log, last_updated). */
  fromItem?(item: ItemMeta, settings: S): V | null;
  /**
   * Label-based types (status, dropdown): the label ids a value references. Lets the service keep labels
   * that are in use (deactivated, never deleted) and re-derive cells when labels change (03 §2.5–2.6).
   */
  labelIds?(value: V): number[];
  /** An address this value still needs coordinates for (location, M8 ד10): the write queues a geocoding job. */
  geocodeQuery?(value: V): string | null;
  /**
   * Text → value (07 §10 paste, 14 §3 bulk edit, automations' fixed values): what a typed or pasted cell becomes in
   * this column. `text` is never blank (`cellFromText` clears on blank first); `undefined` = cannot be read as this
   * type (the cell is skipped), `null` = clears (a checkbox's "no"). Types without it (computed, files, relations,
   * buttons …) are not pasted as text. The one place a type is parsed from text — no switch elsewhere (rule 4).
   */
  fromText?(text: string, settings: S, ctx: TextCtx): V | null | undefined;
}

export type FormulaInput = number | string | boolean | null | { start: string | null; end: string | null };

export type ItemMeta = {
  id: string;
  key: string | null;
  createdAt: string;
  createdBy: string | null;
  lastChangeAt: string;
  lastChangeBy: string | null;
  /** r23ui: the last change of a column (by key) on this item, for a last-updated column of chosen columns. */
  columnChange?: (columnKey: string) => { at: string; by: string | null } | undefined;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyColumnTypeDef = ColumnTypeDef<any, any>;

/** Shared operator sets. */
export const TEXT_OPS: FilterOperator[] = [
  'any_of',
  'not_any_of',
  'is_empty',
  'is_not_empty',
  'contains_text',
  'not_contains_text',
  'starts_with',
  'ends_with',
];
/**
 * Number comparisons. On a text-model column that computes a number (mirror, formula — `toNumber`) they compare
 * that number (M5: imported "greater than 0" conditions on a mirror); a text without a number never matches.
 */
export const NUMBER_COMPARE_OPS: FilterOperator[] = [
  'greater_than',
  'greater_than_or_equal',
  'lower_than',
  'lower_than_or_equal',
  'between',
];
export const comparesNumbers = (model: string, op: string) =>
  model === 'number' || (model === 'text' && (NUMBER_COMPARE_OPS as string[]).includes(op));

export const NUMBER_OPS: FilterOperator[] = [
  'any_of',
  'not_any_of',
  'greater_than',
  'greater_than_or_equal',
  'lower_than',
  'lower_than_or_equal',
  'between',
  'is_empty',
  'is_not_empty',
];
export const DATE_OPS: FilterOperator[] = [
  'any_of',
  'not_any_of',
  'greater_than',
  'lower_than',
  'between',
  'within_the_last',
  'within_the_next',
  'is_empty',
  'is_not_empty',
];
