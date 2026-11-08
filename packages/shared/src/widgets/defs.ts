// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import {
  columnRefSchema,
  dimensionSchema,
  measureSchema,
  widgetBoardsSchema,
  widgetFilterSchema,
  widgetSourceSchema,
} from './common';
import type { WidgetDef } from './types';

/**
 * The widget types of M8 ד4–ד5. Every board-reading widget has `board_ids` (some of the dashboard's boards, or
 * all when empty) and its own `filter`; the dashboard's filter bar applies on top.
 */
const sources = {
  board_ids: widgetBoardsSchema,
  filter: widgetFilterSchema.default({ operator: 'and', rules: [] }),
  /** Round 15: items, subitems or both of every source board. */
  source: widgetSourceSchema,
  /** a click on a value (a number, a bar, a segment, a person) lists the items behind it. */
  drill: z.boolean().default(true),
};

const bucketSchema = z.object({ key: z.string(), label: z.string(), color: z.string().nullable() });

// ---- numbers (KPI) ----
export const numbersSettingsSchema = z.object({
  ...sources,
  measure: measureSchema.default({ fn: 'count', column: null }),
  prefix: z.string().max(12).default(''),
  suffix: z.string().max(12).default(''),
});
export const numbersWidget: WidgetDef<z.infer<typeof numbersSettingsSchema>> = {
  type: 'numbers',
  category: 'data',
  settingsSchema: numbersSettingsSchema,
  defaultSettings: {},
  defaultSize: { w: 3, h: 2 },
  minSize: { w: 2, h: 2 },
  readsBoards: true,
  drill: ['all'],
  dataSchema: z.object({
    value: z.number().nullable(),
    /** As a cell of the column would show it (unit, duration…); a plain number for counts. */
    text: z.string(),
    items: z.number().int(),
    per_board: z.array(z.object({ board_id: z.string(), value: z.number().nullable(), items: z.number().int() })),
  }),
};

// ---- battery (status breakdown) ----
export const batterySettingsSchema = z.object({ ...sources, column: columnRefSchema.nullable().default(null) });
export const batteryWidget: WidgetDef<z.infer<typeof batterySettingsSchema>> = {
  type: 'battery',
  category: 'data',
  settingsSchema: batterySettingsSchema,
  defaultSettings: {},
  defaultSize: { w: 6, h: 2 },
  minSize: { w: 3, h: 2 },
  readsBoards: true,
  drill: ['segment'],
  dataSchema: z.object({
    total: z.number().int(),
    segments: z.array(bucketSchema.extend({ count: z.number().int() })),
  }),
};

// ---- chart ----
export const CHART_TYPES = ['bar', 'stacked_bar', 'line', 'pie', 'donut'] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export const chartSettingsSchema = z.object({
  ...sources,
  chart_type: z.enum(CHART_TYPES).default('bar'),
  /** The X axis (or the slices). */
  x: dimensionSchema.default({ kind: 'board' }),
  /** Stacked bars: what splits each bar. */
  series: dimensionSchema.nullable().default(null),
  measure: measureSchema.default({ fn: 'count', column: null }),
  /** Buckets beyond this fold into "other" (fixed palette order, never cycled colours). */
  max_buckets: z.number().int().min(2).max(30).default(12),
});
export const chartWidget: WidgetDef<z.infer<typeof chartSettingsSchema>> = {
  type: 'chart',
  category: 'data',
  settingsSchema: chartSettingsSchema,
  defaultSettings: {},
  defaultSize: { w: 6, h: 4 },
  minSize: { w: 3, h: 3 },
  readsBoards: true,
  drill: ['x', 'series'],
  dataSchema: z.object({
    series: z.array(bucketSchema),
    rows: z.array(bucketSchema.extend({ values: z.record(z.string(), z.number()) })),
    /** Formats values the way the measured column shows them. */
    unit: z.string().nullable(),
  }),
};

// ---- table / list of items ----
const tableRowsSchema = z.object({
  columns: z.array(z.object({ title: z.string(), type: z.string() })),
  rows: z.array(
    z.object({
      id: z.string(),
      board_id: z.string(),
      board_name: z.string(),
      name: z.string(),
      /** A subitem's parent item (round 15), shown before its name. */
      parent_name: z.string().nullable().optional(),
      cells: z.array(z.object({ text: z.string(), color: z.string().nullable() }).nullable()),
    }),
  ),
  total: z.number().int(),
});
export const tableSettingsSchema = z.object({
  ...sources,
  columns: z.array(columnRefSchema).max(8).default([]),
  limit: z.number().int().min(1).max(200).default(50),
});
export const tableWidget: WidgetDef<z.infer<typeof tableSettingsSchema>> = {
  type: 'table',
  category: 'data',
  settingsSchema: tableSettingsSchema,
  defaultSettings: {},
  defaultSize: { w: 6, h: 4 },
  minSize: { w: 3, h: 3 },
  readsBoards: true,
  dataSchema: tableRowsSchema,
};

// ---- calendar and timeline (items on dates) ----
const datedItemsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      board_id: z.string(),
      name: z.string(),
      parent_name: z.string().nullable().optional(),
      from: z.string(),
      to: z.string(),
      color: z.string().nullable(),
      label: z.string().nullable(),
    }),
  ),
  total: z.number().int(),
});
export const calendarSettingsSchema = z.object({
  ...sources,
  date_column: columnRefSchema.nullable().default(null),
  /** Colours the entries by a status / dropdown column. */
  color_column: columnRefSchema.nullable().default(null),
});
export const calendarWidget: WidgetDef<z.infer<typeof calendarSettingsSchema>> = {
  type: 'calendar',
  category: 'data',
  settingsSchema: calendarSettingsSchema,
  defaultSettings: {},
  defaultSize: { w: 6, h: 5 },
  minSize: { w: 4, h: 4 },
  readsBoards: true,
  dataSchema: datedItemsSchema,
};
export const timelineSettingsSchema = calendarSettingsSchema;
export const timelineWidget: WidgetDef<z.infer<typeof timelineSettingsSchema>> = {
  type: 'timeline',
  category: 'data',
  settingsSchema: timelineSettingsSchema,
  defaultSettings: {},
  defaultSize: { w: 12, h: 4 },
  minSize: { w: 4, h: 3 },
  readsBoards: true,
  dataSchema: datedItemsSchema,
};

// ---- workload (per person) ----
export const workloadSettingsSchema = z.object({
  ...sources,
  people_column: columnRefSchema.nullable().default(null),
  measure: measureSchema.default({ fn: 'count', column: null }),
  /** Splits each person's bar by a status column. */
  split_column: columnRefSchema.nullable().default(null),
});
export const workloadWidget: WidgetDef<z.infer<typeof workloadSettingsSchema>> = {
  type: 'workload',
  category: 'data',
  settingsSchema: workloadSettingsSchema,
  defaultSettings: {},
  defaultSize: { w: 6, h: 4 },
  minSize: { w: 3, h: 3 },
  readsBoards: true,
  drill: ['person', 'series'],
  dataSchema: z.object({
    series: z.array(bucketSchema),
    people: z.array(
      z.object({ id: z.string(), name: z.string(), total: z.number(), values: z.record(z.string(), z.number()) }),
    ),
    unit: z.string().nullable(),
  }),
};

// ---- time report (closes "cross-board time report" from M3) ----
export const TIME_GROUPS = ['user', 'board', 'item', 'day', 'column'] as const;
/** Relative ranges stay relative (resolved on every read in the account's calendar — Fix: ). */
export const TIME_RANGES = [
  'all',
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'last_7',
  'last_30',
  'last_90',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
  'custom',
] as const;
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const timeReportSettingsSchema = z.object({
  ...sources,
  group_by: z.enum(TIME_GROUPS).default('user'),
  /** group_by = column: e.g. the client column (any column — people, connect, dropdown, text). */
  column: columnRefSchema.nullable().default(null),
  range: z.enum(TIME_RANGES).default('this_month'),
  from: isoDay.nullable().default(null),
  to: isoDay.nullable().default(null),
  billable_only: z.boolean().default(false),
});
export const timeReportWidget: WidgetDef<z.infer<typeof timeReportSettingsSchema>> = {
  type: 'time_report',
  category: 'data',
  settingsSchema: timeReportSettingsSchema,
  defaultSettings: {},
  defaultSize: { w: 6, h: 4 },
  minSize: { w: 3, h: 3 },
  readsBoards: true,
  dataSchema: z.object({
    from: z.string().nullable(),
    to: z.string().nullable(),
    total_s: z.number(),
    billable_s: z.number(),
    running: z.number().int(),
    rows: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        duration_s: z.number(),
        billable_s: z.number(),
        entries: z.number().int(),
      }),
    ),
  }),
};

// ---- embedded board view ----
export const boardViewSettingsSchema = z.object({
  board_id: z.string().nullable().default(null),
  /** A saved view of the board (its filter and sort); none = the whole board. */
  view_id: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(200).default(50),
});
export const boardViewWidget: WidgetDef<z.infer<typeof boardViewSettingsSchema>> = {
  type: 'board_view',
  category: 'data',
  settingsSchema: boardViewSettingsSchema,
  defaultSettings: {},
  defaultSize: { w: 12, h: 5 },
  minSize: { w: 4, h: 3 },
  readsBoards: true,
  dataSchema: tableRowsSchema.extend({
    board: z.object({ id: z.string(), name: z.string() }),
    view: z.object({ id: z.string(), name: z.string() }).nullable(),
  }),
};

// ---- an installed extension's widget (D27 ת5) ----
export const extensionWidgetSettingsSchema = z.object({
  installation_id: z.string().max(26).nullable().default(null),
  feature: z.string().max(40).nullable().default(null),
  /** Of the dashboard's boards (all when empty) — the extension's token reads only those the viewer may see. */
  board_ids: widgetBoardsSchema,
});
export const extensionWidget: WidgetDef<z.infer<typeof extensionWidgetSettingsSchema>> = {
  type: 'extension',
  category: 'content',
  settingsSchema: extensionWidgetSettingsSchema,
  defaultSettings: {},
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 2, h: 2 },
  // The page reads through the API with its own token, not through the widget data endpoint.
  readsBoards: false,
  dataSchema: z.null(),
};

// ---- text / notes ----
export const textSettingsSchema = z.object({ text: z.string().max(5000).default('') });
export const textWidget: WidgetDef<z.infer<typeof textSettingsSchema>> = {
  type: 'text',
  category: 'content',
  settingsSchema: textSettingsSchema,
  defaultSettings: {},
  defaultSize: { w: 4, h: 2 },
  minSize: { w: 2, h: 1 },
  readsBoards: false,
  dataSchema: z.null(),
};
