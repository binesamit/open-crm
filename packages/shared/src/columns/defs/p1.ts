// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { popupSchema } from '../../workflows/status-workflow';
import { DATE_OPS, NUMBER_OPS, TEXT_OPS, type ColumnTypeDef } from '../types';
import { PALETTE } from '../../colors';
import { formatDateRange, isValidTimeZone } from '../../locale/format';
import { countryName, isCountryCode, parseCountry } from '../countries';
import { dateOrderOf, parseDateText } from '../date-text';

/**
 * M8 ד10–ד11 — the remaining P1 columns (03 §3): progress, button, hour, week, world clock, colour, country and
 * location. Each is a registry module like the others; text parsing (paste, bulk edit, MCP, automations) is each
 * def's `fromText` (03 §1), built on the `*FromText` helpers below.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const fmt = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const pad = (n: number) => String(n).padStart(2, '0');
const DAY_MS = 86_400_000;
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------
// progress (03 §3.4) — computed on read from status columns (and optionally the subitems)
// ---------------------------------------------------------------------------------------------------------------

const weightSchema = z.number().min(0).max(100);
const labelIdsSchema = z.array(z.number().int().min(0)).max(40).default([]);
/** Where the progress comes from (r15cols): the subitems, status columns of the item itself, or both, weighted. */
export const PROGRESS_SOURCES = ['subitems', 'columns', 'both'] as const;
export type ProgressSource = (typeof PROGRESS_SOURCES)[number];
export const progressSettingsSchema = z.object({
  /**
   * The source. Absent (columns made before r15cols): the old rule — the chosen columns (none = every status
   * column, equal weights) plus the subitems when set.
   */
  source: z.enum(PROGRESS_SOURCES).optional(),
  /** Status columns of the board and their weight; `done_labels` empty = the labels marked "done". */
  columns: z
    .array(z.object({ column_id: z.string().min(1).max(64), weight: weightSchema, done_labels: labelIdsSchema }))
    .max(40)
    .default([]),
  /** A status column of the subitems: the share of subitems on a "done" label counts with this weight. */
  subitems: z
    .object({
      column_id: z.string().min(1).max(64),
      weight: weightSchema,
      /** The labels that count as done; empty = the labels marked "done" in the column. */
      done_labels: labelIdsSchema,
      /** A subitem that has subitems of its own counts by their progress (any depth). */
      recursive: z.boolean().default(false),
      /** A numbers column of the subitems: each subitem counts by its number (all empty / 0 = equal weights). */
      weight_column_id: z.string().min(1).max(64).nullable().default(null),
    })
    .nullable()
    .default(null),
  /** Hide the "68%" text next to the bar. */
  hide_percent: z.boolean().default(false),
});
export type ProgressSettings = z.infer<typeof progressSettingsSchema>;
/** Settings as written (defaults may be left out). */
export type ProgressSettingsInput = z.input<typeof progressSettingsSchema>;
const progressValue = z.object({ percent: z.number().min(0).max(100) });

/** Whether a progress column is set up (r15cols): a chosen source with what it needs. Old columns always are. */
export const progressConfigured = (settings: Partial<ProgressSettingsInput> | null | undefined): boolean => {
  const s = progressSettingsSchema.safeParse(settings ?? {});
  if (!s.success) return false;
  const { source, columns, subitems } = s.data;
  if (!source) return true;
  if (source === 'subitems') return !!subitems;
  if (source === 'columns') return columns.length > 0;
  return !!subitems && columns.length > 0;
};

/** One subitem for `subitemsProgress`: done or not (null: no status column to read), its weight, its subitems. */
export type ProgressNode = { done: boolean | null; weight: number | null; children?: ProgressNode[] };

/**
 * The done share (0–1) of a list of subitems, or null when none can be measured. Each counts by `weight` (when
 * every weight is empty / 0 they count equally). `recursive`: a subitem with measurable subitems counts by their
 * share instead of its own status — so sub-subitems count, at any depth.
 */
export const subitemsProgress = (nodes: ProgressNode[], recursive = false): number | null => {
  const parts: { w: number; d: number }[] = [];
  for (const n of nodes) {
    const nested = recursive && n.children?.length ? subitemsProgress(n.children, true) : null;
    const d = nested ?? (n.done === null ? null : n.done ? 1 : 0);
    if (d === null) continue;
    parts.push({ w: n.weight !== null && Number.isFinite(n.weight) && n.weight > 0 ? n.weight : 0, d });
  }
  if (!parts.length) return null;
  const weighted = parts.some((p) => p.w > 0);
  const total = weighted ? parts.reduce((s, p) => s + p.w, 0) : parts.length;
  return parts.reduce((s, p) => s + (weighted ? p.w : 1) * p.d, 0) / total;
};

/**
 * The progress of one item (0–100, rounded), or null when nothing is measured. `statusColumns`: the board's
 * status column keys (used when old settings name none); `isDone(key, labels)`: the item's label in that column
 * is one of `labels` (empty: a label marked done); `subitems`: the subitems' done share (0–1, see
 * `subitemsProgress`) or their counts.
 */
export const computeProgress = (
  settings: Partial<ProgressSettingsInput> | null | undefined,
  env: {
    statusColumns: string[];
    isDone: (key: string, doneLabels: number[]) => boolean;
    subitems?: { total: number; done: number } | number | null;
  },
): number | null => {
  const s = progressSettingsSchema.parse(settings ?? {});
  if (!progressConfigured(s)) return null;
  const useColumns = s.source !== 'subitems';
  const useSubitems = s.source !== 'columns';
  const parts: { w: number; d: number }[] = [];
  const own = !useColumns
    ? []
    : s.columns.length
      ? s.columns.filter((c) => env.statusColumns.includes(c.column_id))
      : s.subitems || s.source
        ? []
        : env.statusColumns.map((column_id) => ({ column_id, weight: 1, done_labels: [] as number[] }));
  for (const c of own) parts.push({ w: c.weight, d: env.isDone(c.column_id, c.done_labels) ? 1 : 0 });
  const share =
    typeof env.subitems === 'number'
      ? env.subitems
      : env.subitems && env.subitems.total > 0
        ? env.subitems.done / env.subitems.total
        : null;
  // Subitems alone: their share is the progress (the weight only matters next to status columns).
  if (useSubitems && s.subitems && share !== null)
    parts.push({ w: s.source === 'subitems' ? 1 : s.subitems.weight, d: share });
  const total = parts.reduce((n, p) => n + p.w, 0);
  if (!total) return null;
  return Math.round((100 * parts.reduce((n, p) => n + p.w * p.d, 0)) / total);
};

export const progressColumn: ColumnTypeDef<ProgressSettings, z.infer<typeof progressValue>> = {
  type: 'progress',
  labelHe: 'מעקב התקדמות',
  category: 'computed',
  priority: 'P1',
  storage: 'computed',
  engine: 'progress',
  readOnly: true,
  settingsSchema: progressSettingsSchema,
  valueSchema: progressValue,
  // r15cols: a new column starts not set up (its cells and settings say what to choose), on the subitems.
  defaultSettings: progressSettingsSchema.parse({ source: 'subitems' }),
  toText: (v) => `${v.percent}%`,
  toNumber: (v) => v.percent,
  toFormula: (v) => v.percent,
  formatNumber: (n) => `${Math.round(n)}%`,
  filterOperators: NUMBER_OPS,
  filterModel: 'number',
  sortKey: 'number',
  aggregates: ['avg', 'min', 'max', 'median'],
};

// ---------------------------------------------------------------------------------------------------------------
// button (03 §3.7) — no value; a click runs the column's action and fires `button.clicked` for automations
// ---------------------------------------------------------------------------------------------------------------

export const BUTTON_ACTIONS = ['automation', 'open_url', 'set_values', 'popup', 'create_linked'] as const;
const columnRef = z.string().min(1).max(64);
/**
 * P1-03: "create a linked item" — the click opens a popup with columns of ANOTHER board; saving creates
 * an item there (or fills in the linked one `reuse` finds), linked to the clicked item. Everything is a setting.
 */
export const createLinkedSchema = z.object({
  kind: z.literal('create_linked'),
  /** The board the new item goes to. */
  board_id: z.string().max(64).default(''),
  /** The relation that links them: a column of this board (to the target board), or of the target board (back). */
  link: z.object({ on: z.enum(['source', 'target']), column_id: columnRef }).optional(),
  /** Values copied from the clicked item ('name' = its name) to the new item's columns, converted by type. */
  copy: z
    .array(z.object({ from: columnRef, to: columnRef }))
    .max(30)
    .default([]),
  /** Fixed values for the new item, as text (like set_values: labels by name …). */
  fixed: z
    .array(z.object({ column_id: columnRef, text: z.string().max(2000) }))
    .max(20)
    .default([]),
  /** The popup — columns of the target board (and its subitems). No fields = the item is created at once. */
  popup: popupSchema.default({ fields: [] }),
  /**
   * When a linked item whose status column is one of these labels (or empty) exists, the popup opens on it to fill
   * in instead of creating another one. Unset = always create.
   */
  reuse: z
    .object({
      column_id: columnRef,
      labels: z.array(z.number().int().min(0)).max(100).default([]),
      empty: z.boolean().default(false),
    })
    .optional(),
  /** After saving: a toast with "open", or the new item's card over the board. */
  after: z.enum(['toast', 'open']).default('toast'),
});
export type CreateLinkedAction = z.infer<typeof createLinkedSchema>;
export const buttonActionSchema = z.discriminatedUnion('kind', [
  /** Only the event: automations with "when the button is clicked" run. */
  z.object({ kind: z.literal('automation') }),
  /** A link with the item's values (`{item.<column>}`, `{item.name}`, `{item.id}` — the automation templates). */
  z.object({ kind: z.literal('open_url'), url: z.string().trim().max(2000) }),
  /** Set columns of the item from text (like a paste: labels by name, people by name or email, dates…). */
  z.object({
    kind: z.literal('set_values'),
    values: z
      .array(z.object({ column_id: z.string().min(1).max(64), text: z.string().max(2000) }))
      .max(20)
      .default([]),
  }),
  /** phase 2: a popup asks for values (and a note) first; they are saved with the click, in one write. */
  z.object({ kind: z.literal('popup'), popup: popupSchema }),
  createLinkedSchema,
]);
export type ButtonAction = z.infer<typeof buttonActionSchema>;
export const buttonSettingsSchema = z.object({
  /** The text on the button; empty = the column's title. */
  label: z.string().trim().max(40).default(''),
  color: hex.default(PALETTE.forest.light),
  /** Ask "are you sure?" before running. */
  confirm: z.boolean().default(false),
  action: buttonActionSchema.default({ kind: 'automation' }),
});
export type ButtonSettings = z.infer<typeof buttonSettingsSchema>;

export const buttonColumn: ColumnTypeDef<ButtonSettings, Record<string, never>> = {
  type: 'button',
  labelHe: 'כפתור',
  category: 'super_useful',
  priority: 'P1',
  storage: 'computed',
  engine: 'button',
  // Clicked through POST /items/:id/buttons/:column (the right to edit the column), never PUT /cells.
  readOnly: false,
  settingsSchema: buttonSettingsSchema,
  valueSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  defaultSettings: buttonSettingsSchema.parse({}),
  toText: () => '',
  filterOperators: [],
  filterModel: 'text',
  sortKey: 'none',
  aggregates: [],
};

// ---------------------------------------------------------------------------------------------------------------
// hour (03 §3.8)
// ---------------------------------------------------------------------------------------------------------------

const hourValue = z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) });
export type HourValue = z.infer<typeof hourValue>;
const timeFormat = z.enum(['auto', '24h', '12h']);
const hourSettings = z.object({ format: timeFormat.default('auto') });

/** 13:05 or 1:05 PM. */
export const formatHourValue = (v: HourValue, format: '24h' | '12h' = '24h') => {
  if (format === '24h') return `${pad(v.hour)}:${pad(v.minute)}`;
  const h = v.hour % 12 || 12;
  return `${h}:${pad(v.minute)} ${v.hour < 12 ? 'AM' : 'PM'}`;
};

/** "9:30", "09:30", "9.30", "930", "9", "9:30 pm", "21:00" → {hour, minute}; else undefined. */
export const hourFromText = (text: string): HourValue | undefined => {
  const t = text.trim().toLowerCase();
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(t) ?? /^(\d{2})(\d{2})()$/.exec(t);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.replace(/\./g, '');
  if (ap) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (ap === 'pm' ? 12 : 0);
  }
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
};

export const hourColumn: ColumnTypeDef<z.infer<typeof hourSettings>, HourValue> = {
  type: 'hour',
  labelHe: 'שעה',
  category: 'super_useful',
  priority: 'P1',
  storage: 'cell',
  readOnly: false,
  settingsSchema: hourSettings,
  valueSchema: hourValue,
  defaultSettings: { format: 'auto' },
  // The column's format, else the reader's (A3); stored canonically as 24h.
  toText: (v, s, ctx) => formatHourValue(v, s.format === 'auto' ? (ctx.region?.time_format ?? '24h') : s.format),
  fromText: (text) => hourFromText(text.trim()),
  localizedText: true,
  toNumber: (v) => v.hour * 60 + v.minute,
  toFormula: (v) => `${pad(v.hour)}:${pad(v.minute)}`,
  formatNumber: (n) => formatHourValue({ hour: Math.floor(n / 60) % 24, minute: Math.round(n % 60) % 60 }),
  filterOperators: [...TEXT_OPS.filter((o) => o !== 'starts_with' && o !== 'ends_with')],
  filterModel: 'text',
  sortKey: 'number',
  aggregates: ['count'],
};

// ---------------------------------------------------------------------------------------------------------------
// week (03 §3.9) — seven days from the account's first weekday
// ---------------------------------------------------------------------------------------------------------------

const weekValue = z
  .object({ start: isoDate, end: isoDate })
  .refine((v) => addDays(v.start, 6) === v.end, { message: 'a week is 7 days' });
export type WeekValue = z.infer<typeof weekValue>;

/** The week (`firstDay` 0 = Sunday … 6) a date falls in. */
export const weekOf = (iso: string, firstDay = 0): WeekValue => {
  const d = new Date(`${iso}T00:00:00Z`);
  const start = addDays(iso, -((d.getUTCDay() - firstDay + 7) % 7));
  return { start, end: addDays(start, 6) };
};

/** ISO-8601 week number of a date (for the "W12" chip). */
export const isoWeekNumber = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // the Thursday of its week
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
};

export const weekColumn: ColumnTypeDef<{ first_day?: number }, WeekValue> = {
  type: 'week',
  labelHe: 'שבוע',
  category: 'super_useful',
  priority: 'P1',
  storage: 'cell',
  readOnly: false,
  /** `first_day`: the column's own week start (else the account's, which the picker uses). */
  settingsSchema: z.object({ first_day: z.number().int().min(0).max(6).optional() }),
  valueSchema: weekValue,
  defaultSettings: {},
  toText: (v, _s, ctx) =>
    ctx.region ? formatDateRange(v.start, v.end, {}, ctx.region) : `${fmt(v.start)} – ${fmt(v.end)}`,
  // One date = its week (by the column's first day, else the account's — as the picker); "start – end" must be a
  // whole week. Dates in the account's day / month order (A3, A4).
  fromText: (text, s, ctx) => {
    const order = dateOrderOf(ctx.region?.date_format);
    const [a, b] = text.trim().split(/\s+[–—-]\s+/);
    const from = a ? parseDateText(a, order) : null;
    if (!from) return undefined;
    const first = s?.first_day ?? ctx.region?.first_day ?? 0;
    if (b) {
      const to = parseDateText(b, order);
      return to && addDays(from, 6) === to ? { start: from, end: to } : undefined;
    }
    return weekOf(from, first);
  },
  localizedText: true,
  toDate: (v) => v.start,
  toDateEnd: (v) => v.end,
  toFormula: (v) => ({ start: v.start, end: v.end }),
  filterOperators: DATE_OPS,
  filterModel: 'date',
  sortKey: 'date',
  aggregates: ['earliest', 'latest', 'range'],
};

// ---------------------------------------------------------------------------------------------------------------
// world clock (03 §3.10)
// ---------------------------------------------------------------------------------------------------------------

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const worldClockSettings = z.object({
  format: timeFormat.default('auto'),
  /** Working hours in the clock's zone: the cell shows whether it is working time there now. */
  work_start: hhmm.default('09:00'),
  work_end: hhmm.default('18:00'),
  /** Working weekdays (0 = Sunday); the cell greys out outside them. */
  work_days: z.array(z.number().int().min(0).max(6)).max(7).default([0, 1, 2, 3, 4]),
});
export type WorldClockSettings = z.infer<typeof worldClockSettings>;
const worldClockValue = z.object({ timezone: z.string().min(1).max(64).refine(isValidTimeZone, 'unknown timezone') });

let zones: string[] | null = null;
/** Every IANA zone the runtime knows (a short fallback list where `supportedValuesOf` is missing). */
export const timeZones = (): string[] => {
  if (zones) return zones;
  try {
    zones = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    zones = ['UTC', 'Asia/Jerusalem', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles'];
  }
  if (!zones.includes('UTC')) zones = ['UTC', ...zones];
  return zones;
};

/** The city part of a zone: "America/New_York" → "New York". */
export const zoneCity = (tz: string) => (tz.split('/').pop() ?? tz).replace(/_/g, ' ');

/** A zone name ("asia/jerusalem") or its city ("New York") → the zone, else undefined. */
export const timeZoneFromText = (text: string): string | undefined => {
  const t = text.trim().toLowerCase().replace(/\s+/g, '_');
  if (!t) return undefined;
  const all = timeZones();
  return all.find((z) => z.toLowerCase() === t) ?? all.find((z) => (z.split('/').pop() ?? '').toLowerCase() === t);
};

/** Local time in a zone ("HH:MM") and its weekday, for the live clock and working hours. */
export const zoneNow = (tz: string, now: Date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { hour, minute, weekday };
};

/** Is it working time in the clock's zone now (by the column's working hours and days)? */
export const isWorkingTime = (tz: string, s: Partial<WorldClockSettings>, now: Date = new Date()) => {
  const p = worldClockSettings.parse(s);
  const { hour, minute, weekday } = zoneNow(tz, now);
  if (!p.work_days.includes(weekday)) return false;
  const at = `${pad(hour)}:${pad(minute)}`;
  return p.work_start <= p.work_end ? at >= p.work_start && at < p.work_end : at >= p.work_start || at < p.work_end;
};

export const worldClockColumn: ColumnTypeDef<WorldClockSettings, z.infer<typeof worldClockValue>> = {
  type: 'world_clock',
  labelHe: 'שעון עולמי',
  category: 'super_useful',
  priority: 'P1',
  storage: 'cell',
  readOnly: false,
  settingsSchema: worldClockSettings,
  valueSchema: worldClockValue,
  defaultSettings: worldClockSettings.parse({}),
  toText: (v) => v.timezone,
  fromText: (text) => {
    const tz = timeZoneFromText(text.trim());
    return tz ? { timezone: tz } : undefined;
  },
  filterOperators: ['any_of', 'not_any_of', 'is_empty', 'is_not_empty', 'contains_text', 'not_contains_text'],
  filterModel: 'text',
  sortKey: 'text',
  aggregates: ['count'],
};

// ---------------------------------------------------------------------------------------------------------------
// colour picker (03 §3.12)
// ---------------------------------------------------------------------------------------------------------------

const colorSettings = z.object({ format: z.enum(['hex', 'rgb']).default('hex') });
const colorValue = z.object({ color: hex.transform((c) => c.toLowerCase()) });

const toRgb = (c: string) => `rgb(${[1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).join(', ')})`;

/** "#1a2b3c", "1A2B3C", "#abc", "rgb(26, 43, 60)" → "#1a2b3c"; else undefined. */
export const colorFromText = (text: string): string | undefined => {
  const t = text.trim().toLowerCase();
  let m = /^#?([0-9a-f]{6})$/.exec(t);
  if (m) return `#${m[1]}`;
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  const r = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(t);
  if (r && [r[1], r[2], r[3]].every((x) => Number(x) <= 255))
    return `#${[r[1], r[2], r[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
  return undefined;
};

export const colorPickerColumn: ColumnTypeDef<z.infer<typeof colorSettings>, z.infer<typeof colorValue>> = {
  type: 'color_picker',
  labelHe: 'בוחר צבעים',
  category: 'super_useful',
  priority: 'P1',
  storage: 'cell',
  readOnly: false,
  settingsSchema: colorSettings,
  valueSchema: colorValue as unknown as z.ZodType<z.infer<typeof colorValue>>,
  defaultSettings: { format: 'hex' },
  toText: (v, s) => (s.format === 'rgb' ? toRgb(v.color) : v.color.toUpperCase()),
  fromText: (text) => {
    const c = colorFromText(text.trim());
    return c ? { color: c } : undefined;
  },
  filterOperators: ['any_of', 'not_any_of', 'is_empty', 'is_not_empty', 'contains_text'],
  filterModel: 'text',
  sortKey: 'text',
  aggregates: ['count'],
};

// ---------------------------------------------------------------------------------------------------------------
// country (03 §3.5)
// ---------------------------------------------------------------------------------------------------------------

const countryValue = z.object({ code: z.string().refine(isCountryCode, 'unknown country') });

export const countryColumn: ColumnTypeDef<Record<string, unknown>, z.infer<typeof countryValue>> = {
  type: 'country',
  labelHe: 'מדינה',
  category: 'super_useful',
  priority: 'P1',
  storage: 'cell',
  readOnly: false,
  settingsSchema: z.object({}).loose(),
  valueSchema: countryValue,
  defaultSettings: {},
  // The reader's language (A3); the stored text holds both names, so a search finds it in Hebrew or English.
  toText: (v, _s, ctx) =>
    ctx.region || ctx.locale
      ? countryName(v.code, ctx.region?.language ?? ctx.locale)
      : `${countryName(v.code, 'he')} · ${countryName(v.code, 'en')}`,
  fromText: (text) => {
    const code = parseCountry(text.trim());
    return code ? { code } : undefined;
  },
  localizedText: true,
  filterOperators: ['any_of', 'not_any_of', 'is_empty', 'is_not_empty', 'contains_text', 'not_contains_text'],
  filterModel: 'text',
  sortKey: 'text',
  aggregates: ['count'],
};

// ---------------------------------------------------------------------------------------------------------------
// location (03 §3.6) — an address; lat/lng come from the geocoding queue (or a picked place)
// ---------------------------------------------------------------------------------------------------------------

export const locationValueSchema = z
  .object({
    address: z.string().trim().min(1).max(500),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    place_id: z.string().max(300).optional(),
    country_code: z.string().length(2).optional(),
    /** The geocoder found nothing for this address (the queue does not try it again). */
    geocode_failed: z.boolean().optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: 'lat and lng go together' });
export type LocationValue = z.infer<typeof locationValueSchema>;

/** "32.08, 34.78" (decimal degrees) → coordinates. */
const LATLNG_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
export const locationFromText = (text: string): LocationValue | undefined => {
  const t = text.trim().slice(0, 500);
  if (!t) return undefined;
  const m = LATLNG_RE.exec(t);
  if (m) {
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { address: t, lat, lng };
  }
  return { address: t };
};

/** The address a location value still needs coordinates for (the geocoding queue), else null. */
export const pendingGeocode = (value: unknown): string | null => {
  const v = value as Partial<LocationValue> | null;
  return v && typeof v.address === 'string' && v.lat === undefined && !v.geocode_failed ? v.address : null;
};

export const locationColumn: ColumnTypeDef<Record<string, unknown>, LocationValue> = {
  type: 'location',
  labelHe: 'מיקום',
  category: 'super_useful',
  priority: 'P1',
  storage: 'cell',
  readOnly: false,
  settingsSchema: z.object({}).loose(),
  valueSchema: locationValueSchema,
  defaultSettings: {},
  toText: (v) => v.address,
  fromText: (text) => locationFromText(text.trim()),
  toFormula: (v) => v.address,
  geocodeQuery: pendingGeocode,
  filterOperators: TEXT_OPS,
  filterModel: 'text',
  sortKey: 'text',
  aggregates: ['count'],
};
