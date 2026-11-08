// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { DATE_OPS, type ColumnTypeDef } from '../types';
import { formatDate, formatDateRange, formatDateValue, storedDateValue } from '../../locale/format';
import type { IsoDate } from '../../calendar';
import { dateOrderOf, parseDateText } from '../date-text';
import type { TimelineSettings } from '../timeline-overdue';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const fmt = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

const deadline = z.object({ status_column_id: z.string(), people_column_id: z.string().optional() }).optional();
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const dateSettings = z.object({
  /** "Include time": the cell's picker offers a time, in the viewer's region zone. Off by default. */
  show_time: z.boolean().optional(),
  /** The wall-clock time a newly added time starts at ("HH:MM"); unset = DEFAULT_DATE_TIME. */
  default_time: hm.optional(),
  show_weekday: z.boolean().optional(),
  hide_current_year: z.boolean().optional(),
  deadline,
  rollup: z.enum(['earliest', 'latest', 'none']).optional(),
  /** The Hebrew date in the cell: unset / 'account' = the account's setting. */
  hebrew_date: z.enum(['account', 'on', 'off']).optional(),
  /** Dots for days off / half days in the picker: unset / 'account' = the account's setting. */
  day_marks: z.enum(['account', 'on', 'off']).optional(),
});
const dateValue = z.object({
  date: isoDate,
  time: z
    .string()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/)
    .optional(),
});

/** The time a date cell's "add time" starts at when the column sets none (column setting `default_time`). */
export const DEFAULT_DATE_TIME = '09:00';

/** 03 §2.7 — time is UTC; shown in the viewer's timezone. */
export const dateColumn: ColumnTypeDef<z.infer<typeof dateSettings>, z.infer<typeof dateValue>> = {
  type: 'date',
  labelHe: 'תאריך',
  category: 'essentials',
  priority: 'P0',
  storage: 'cell',
  readOnly: false,
  settingsSchema: dateSettings,
  valueSchema: dateValue,
  defaultSettings: {},
  // A3: the reader's region (format, zone, the column's weekday / current-year options); canonical when stored.
  toText: (v, s, ctx) =>
    ctx.region ? formatDateValue(v, ctx.region, s) : v.time ? `${fmt(v.date)} ${v.time.slice(0, 5)}` : fmt(v.date),
  localizedText: true,
  /**
   * "date" or "date HH:MM" in the account's date order; a time is wall-clock in the region's zone and is stored as
   * the UTC instant (audit 2026-10-10 A1) — without a region, as UTC.
   */
  fromText: (text, _s, ctx) => {
    const m = /^(.+?)(?:\s+(\d{1,2}):(\d{2}))?$/.exec(text.trim());
    if (!m) return undefined; // several lines
    const date = parseDateText(m[1]!, dateOrderOf(ctx.region?.date_format));
    if (!date) return undefined;
    if (!m[2]) return { date };
    const time = `${m[2].padStart(2, '0')}:${m[3]}`;
    if (!ctx.region) return { date, time };
    return storedDateValue(date as IsoDate, time, ctx.region);
  },
  toDate: (v) => (v.time ? `${v.date}T${v.time.length === 5 ? `${v.time}:00` : v.time}Z` : v.date),
  toFormula: (v) => (v.time ? `${v.date}T${v.time.length === 5 ? `${v.time}:00` : v.time}Z` : v.date),
  filterOperators: DATE_OPS,
  filterModel: 'date',
  sortKey: 'date',
  aggregates: ['earliest', 'latest', 'range'],
};

/**
 * a timeline "with hours" (`show_time`) also keeps a start and an end time — wall-clock "HH:MM" in the
 * account's zone, like the hour column, so `from` / `to` stay the calendar days every other reader expects. Both
 * times or neither; on one day the end is after the start.
 */
const timelineValue = z
  .object({
    from: isoDate,
    to: isoDate,
    milestone: z.boolean().optional(),
    from_time: hm.optional(),
    to_time: hm.optional(),
  })
  .refine((v) => v.from <= v.to, { message: 'from must be on or before to' })
  .refine((v) => !v.from_time === !v.to_time, { message: 'from_time and to_time go together' })
  .refine((v) => !v.from_time || v.from < v.to || v.from_time < v.to_time!, {
    message: 'the end must be after the start',
  });

/** "05/10/2026 09:00 – 10:30" / "05/10/2026 22:00 – 06/10/2026 02:00": a timeline with hours as text. */
const timelineTimedText = (v: z.infer<typeof timelineValue>, date: (d: string) => string) =>
  v.from === v.to
    ? `${date(v.from)} ${v.from_time} – ${v.to_time}`
    : `${date(v.from)} ${v.from_time} – ${date(v.to)} ${v.to_time}`;

/** 03 §2.8 */
export const timelineColumn: ColumnTypeDef<TimelineSettings, z.infer<typeof timelineValue>> = {
  type: 'timeline',
  labelHe: 'ציר זמן',
  category: 'essentials',
  priority: 'P0',
  storage: 'cell',
  readOnly: false,
  settingsSchema: z.object({
    show_weekends: z.boolean().optional(),
    allow_milestone: z.boolean().optional(),
    /** "with hours" — the picker also asks for a start and an end time. Off by default. */
    show_time: z.boolean().optional(),
    // r26: red when overdue (default on), unless the linked status is one of its done labels.
    overdue_red: z.boolean().optional(),
    status_column_id: z.string().optional(),
    done_label_ids: z.array(z.number().int().min(0)).max(40).optional(),
    // how the span is counted, showing it, keeping it on a move, the Hebrew date.
    duration: z.enum(['account', 'calendar', 'weekdays', 'workdays']).optional(),
    show_duration: z.boolean().optional(),
    keep_workdays: z.boolean().optional(),
    hebrew_date: z.enum(['account', 'on', 'off']).optional(),
    day_marks: z.enum(['account', 'on', 'off']).optional(),
  }),
  valueSchema: timelineValue,
  defaultSettings: {},
  toText: (v, _s, ctx) =>
    v.from_time
      ? timelineTimedText(v, (d) => (ctx.region ? formatDate(d as IsoDate, {}, ctx.region) : fmt(d)))
      : ctx.region
        ? formatDateRange(v.from, v.to, {}, ctx.region)
        : v.from === v.to
          ? fmt(v.from)
          : `${fmt(v.from)} – ${fmt(v.to)}`,
  localizedText: true,
  // "from – to" (a dash between), or one date for both ends — in the account's day / month order (A3). With hours:
  // "date HH:MM – HH:MM" (one day) or "date HH:MM – date HH:MM".
  fromText: (text, _s, ctx) => {
    const order = dateOrderOf(ctx.region?.date_format);
    const [a, b] = text.trim().split(/\s+[–—-]\s+/);
    const timed = /^(.+?)\s+(\d{1,2}):(\d{2})$/;
    const ta = timed.exec(a ?? '');
    if (ta) {
      const from = parseDateText(ta[1]!, order);
      const hmOf = (h: string, mi: string) => (Number(h) <= 23 ? `${h.padStart(2, '0')}:${mi}` : null);
      const fromTime = hmOf(ta[2]!, ta[3]!);
      const tb = /^(\d{1,2}):(\d{2})$/.exec(b ?? '') ?? timed.exec(b ?? '');
      if (!from || !fromTime || !tb) return undefined;
      const to = tb.length === 3 ? from : parseDateText(tb[1]!, order);
      const toTime = tb.length === 3 ? hmOf(tb[1]!, tb[2]!) : hmOf(tb[2]!, tb[3]!);
      if (!to || !toTime || to < from || (to === from && toTime <= fromTime)) return undefined;
      return { from, to, from_time: fromTime, to_time: toTime };
    }
    const from = parseDateText(a ?? '', order);
    const to = b ? parseDateText(b, order) : from;
    return from && to && from <= to ? { from, to } : undefined;
  },
  toDate: (v) => v.from,
  toDateEnd: (v) => v.to,
  toFormula: (v) => ({ start: v.from, end: v.to }),
  filterOperators: DATE_OPS,
  filterModel: 'date',
  sortKey: 'date',
  aggregates: ['earliest', 'latest', 'range'],
};
