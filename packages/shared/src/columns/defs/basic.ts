// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { NUMBER_OPS, TEXT_OPS, type ColumnTypeDef } from '../types';
import { DEFAULT_REGION, formatNumber } from '../../locale/format';
import { nameSourceSchema } from '../name-source';
import { parseNumberText } from '../date-text';
import { normText } from '../text-ctx';

const NUMBER_TEXT_REGION = { ...DEFAULT_REGION, language: 'en' as const };

/** 03 §2.1 — the item name; stored on `items.name`, never in cells. */
export const nameColumn: ColumnTypeDef<Record<string, unknown>, string> = {
  type: 'name',
  labelHe: 'שם',
  category: 'essentials',
  priority: 'P0',
  storage: 'item',
  readOnly: false,
  /** `name_source`: free (typed) / one column / a template — the server computes the name. */
  settingsSchema: z.object({ name_source: nameSourceSchema.optional() }).loose(),
  valueSchema: z.string().trim().min(1).max(255),
  defaultSettings: {},
  toText: (v) => v,
  filterOperators: ['any_of', 'not_any_of', 'contains_text', 'not_contains_text'],
  filterModel: 'text',
  sortKey: 'text',
  aggregates: [],
};

const textSettings = z.object({
  hide_footer: z.boolean().optional(),
  wrap: z.boolean().optional(),
  /** Suggest the column's existing values while typing (03 §2.2, M1.1 #18); on unless false. */
  suggest: z.boolean().optional(),
});

/** 03 §2.2 */
export const textColumn: ColumnTypeDef<z.infer<typeof textSettings>, string> = {
  type: 'text',
  labelHe: 'טקסט',
  category: 'essentials',
  priority: 'P0',
  storage: 'cell',
  readOnly: false,
  settingsSchema: textSettings,
  valueSchema: z.string().max(2000),
  defaultSettings: {},
  toText: (v) => v,
  fromText: (text) => text.trim().slice(0, 2000),
  filterOperators: TEXT_OPS,
  filterModel: 'text',
  sortKey: 'text',
  aggregates: ['count'],
};

const longTextValue = z.object({ text: z.string().max(20000) });

/** 03 §2.3 */
export const longTextColumn: ColumnTypeDef<{ hide_footer?: boolean }, z.infer<typeof longTextValue>> = {
  type: 'long_text',
  labelHe: 'טקסט ארוך',
  category: 'essentials',
  priority: 'P0',
  storage: 'cell',
  readOnly: false,
  settingsSchema: z.object({ hide_footer: z.boolean().optional() }),
  valueSchema: longTextValue,
  defaultSettings: {},
  toText: (v) => v.text,
  // The text as typed (line breaks kept), cut at the limit.
  fromText: (text) => ({ text: text.slice(0, 20000) }),
  filterOperators: TEXT_OPS,
  filterModel: 'text',
  sortKey: 'text',
  aggregates: ['count'],
};

/** How a number is shown (03 §2.4): numbers columns, and formulas with a number result (03 §2.18). */
export const numberFormatSettings = z.object({
  unit: z.object({ symbol: z.string().max(8), direction: z.enum(['left', 'right']) }).optional(),
  /** Fixed decimals; -1 / absent = as is. */
  precision: z.number().int().min(-1).max(4).optional(),
  thousands: z.boolean().optional(),
});
export type NumberFormat = z.infer<typeof numberFormatSettings>;

/** A number as text with a unit, fixed decimals and a thousands separator (language-neutral: 1,234.50). */
export const formatNumberAs = (v: number, s: NumberFormat): string => {
  const p = s.precision !== undefined && s.precision >= 0 ? s.precision : null;
  const fixed = p !== null ? v.toFixed(p) : String(v);
  // 1,234.50 with 2 decimals: the separator must not drop the fixed decimals.
  const shown = s.thousands
    ? formatNumber(
        Number(fixed),
        { minimumFractionDigits: p ?? 0, maximumFractionDigits: p ?? 4 },
        // The stored text is language-neutral (1,234.50 — the same in Hebrew and English).
        NUMBER_TEXT_REGION,
      )
    : fixed;
  if (!s.unit?.symbol) return shown;
  return s.unit.direction === 'left' ? `${s.unit.symbol}${shown}` : `${shown}${s.unit.symbol}`;
};

const numbersSettings = numberFormatSettings.extend({
  footer: z.enum(['none', 'sum', 'avg', 'median', 'min', 'max', 'count']).optional(),
  rollup: z.enum(['sum', 'min', 'max', 'none']).optional(),
});

/** 03 §2.4 — value is a JSON number; numeric strings from the API are coerced. */
export const numbersColumn: ColumnTypeDef<z.infer<typeof numbersSettings>, number> = {
  type: 'numbers',
  labelHe: 'מספרים',
  category: 'essentials',
  priority: 'P0',
  storage: 'cell',
  readOnly: false,
  settingsSchema: numbersSettings,
  valueSchema: z.coerce.number().finite(),
  defaultSettings: { footer: 'sum' },
  // a new numbers column shows 1,000 unless the account turned it off; older columns (unset) don't.
  newColumnSettings: (d) => ({ thousands: d.number_thousands ?? true }),
  toText: (v, s) => formatNumberAs(v, s),
  fromText: (text) => parseNumberText(text.trim()),
  toNumber: (v) => v,
  toFormula: (v) => v,
  formatNumber: (n, s) => numbersColumn.toText(Math.round(n * 10000) / 10000, s, {}),
  filterOperators: NUMBER_OPS,
  filterModel: 'number',
  sortKey: 'number',
  aggregates: ['sum', 'avg', 'median', 'min', 'max', 'count'],
};

const ratingSettings = z.object({
  max: z.union([z.literal(3), z.literal(4), z.literal(5), z.literal(10)]),
  symbol: z.enum(['stars', 'hearts']).optional(),
});
const ratingValue = z.object({ rating: z.number().int().min(1).max(10) });

/** 03 §2.14 */
export const ratingColumn: ColumnTypeDef<z.infer<typeof ratingSettings>, z.infer<typeof ratingValue>> = {
  type: 'rating',
  labelHe: 'דירוג',
  category: 'super_useful',
  priority: 'P0',
  storage: 'cell',
  readOnly: false,
  settingsSchema: ratingSettings,
  valueSchema: ratingValue,
  defaultSettings: { max: 5, symbol: 'stars' },
  toText: (v) => String(v.rating),
  fromText: (text) => {
    const n = Number(text.trim());
    return Number.isInteger(n) && n >= 1 && n <= 10 ? { rating: n } : undefined;
  },
  toNumber: (v) => v.rating,
  toFormula: (v) => v.rating,
  formatNumber: (n) => n.toFixed(1).replace(/\.0$/, ''),
  validate: (v, s) => (v.rating <= s.max ? null : 'rating_out_of_range'),
  filterOperators: ['any_of', 'greater_than', 'lower_than', 'is_empty', 'is_not_empty'],
  filterModel: 'number',
  sortKey: 'number',
  aggregates: ['avg'],
};

const checkboxValue = z.object({ checked: z.boolean() });

/** 03 §2.13 — `null` (no cell) = unchecked. */
export const checkboxColumn: ColumnTypeDef<{ color?: string }, z.infer<typeof checkboxValue>> = {
  type: 'checkbox',
  labelHe: 'תיבת סימון',
  category: 'essentials',
  priority: 'P0',
  storage: 'cell',
  readOnly: false,
  settingsSchema: z.object({ color: z.string().optional() }),
  valueSchema: checkboxValue,
  defaultSettings: {},
  toText: (v) => (v.checked ? 'v' : ''),
  // A "yes" word checks; a "no" word clears (null); anything else is not a checkbox.
  fromText: (text) =>
    ['v', '✓', '✔', 'x', 'true', '1', 'yes', 'כן'].includes(normText(text))
      ? { checked: true }
      : ['false', '0', 'no', 'לא'].includes(normText(text))
        ? null
        : undefined,
  toNumber: (v) => (v.checked ? 1 : 0),
  toFormula: (v) => v.checked,
  filterOperators: ['is_empty', 'is_not_empty'],
  filterModel: 'checkbox',
  sortKey: 'number',
  aggregates: ['count_done'],
};

const voteValue = z.object({ voter_ids: z.array(z.string()).max(10000) });

/**
 * 03 §3.11 — one vote per user, written only through `POST /items/:id/vote` (engine 'vote'); the number is the
 * count of voters.
 */
export const voteColumn: ColumnTypeDef<Record<string, unknown>, z.infer<typeof voteValue>> = {
  type: 'vote',
  labelHe: 'הצבעה',
  category: 'super_useful',
  priority: 'P1',
  storage: 'cell',
  engine: 'vote',
  readOnly: false, // written through the vote endpoint, never PUT /cells
  settingsSchema: z.object({}).loose(),
  valueSchema: voteValue,
  defaultSettings: {},
  toText: (v) => (v.voter_ids.length ? String(v.voter_ids.length) : ''),
  toNumber: (v) => v.voter_ids.length,
  toFormula: (v) => v.voter_ids.length,
  filterOperators: ['any_of', 'greater_than', 'lower_than', 'is_empty', 'is_not_empty'],
  filterModel: 'number',
  sortKey: 'number',
  aggregates: ['sum'],
};

const docValue = z.object({ doc_id: z.string().min(1).max(26), name: z.string().max(255).optional() });

/**
 * 03 §3.13 — a doc inside the item's cell (M8 ד2). Created through `POST /items/:id/cells/:col/doc` (engine
 * 'doc'), never PUT /cells; the doc has the item's permissions and opens in a side panel. The text is its name.
 */
export const docColumn: ColumnTypeDef<{ template_doc_id?: string }, z.infer<typeof docValue>> = {
  type: 'doc',
  labelHe: 'מסמך',
  category: 'super_useful',
  priority: 'P1',
  storage: 'cell',
  engine: 'doc',
  readOnly: false, // written through the cell-doc endpoint, never PUT /cells
  settingsSchema: z.object({ template_doc_id: z.string().max(26).optional() }).loose(),
  valueSchema: docValue,
  defaultSettings: {},
  toText: (v) => v.name ?? '',
  filterOperators: ['is_empty', 'is_not_empty', 'contains_text'],
  filterModel: 'text',
  sortKey: 'text',
  aggregates: ['count'],
};
