// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { columnTypes } from '../columns';
import { FILTER_OPERATORS, type FilterGroup, type FilterRule } from '../query/filter';

/**
 * Pieces every dashboard widget's settings are made of (M8 ד4). A widget reads several boards, whose columns have
 * different keys: a column is named by its **type + title** — the same column on every source board —
 * with an explicit key per board when titles differ (`keys`).
 */
export const columnRefSchema = z.object({
  type: z.string().min(1).max(40),
  title: z.string().max(255),
  /** board id → column key: the manual choice in the widget's settings (wins over the title match). */
  keys: z.record(z.string(), z.string().max(64)).optional(),
});
export type ColumnRef = z.infer<typeof columnRefSchema>;

/** A board column as the widget settings see it (Column DTO: `id` is the key). */
export type RefColumn = { id: string; type: string; title: string };

const norm = (s: string) => s.trim().toLocaleLowerCase();

/** The key of `ref` on a board: its manual key when that column still exists, else the same type + title. */
export const resolveColumnRef = (ref: ColumnRef, boardId: string, columns: RefColumn[]): string | null => {
  const manual = ref.keys?.[boardId];
  if (manual && columns.some((c) => c.id === manual)) return manual;
  return columns.find((c) => c.type === ref.type && norm(c.title) === norm(ref.title))?.id ?? null;
};

/** What a widget field accepts: label columns, numbers, dates, people, or any column that can be shown. */
export type ColumnRole = 'labels' | 'number' | 'date' | 'people' | 'any';

const NUMERIC_AGGS = ['sum', 'avg', 'median', 'min', 'max'] as const;

export const columnFitsRole = (type: string, role: ColumnRole): boolean => {
  const def = columnTypes.get(type);
  if (!def) return false;
  switch (role) {
    case 'labels':
      return def.filterModel === 'label' || def.filterModel === 'labels';
    case 'number':
      return NUMERIC_AGGS.some((a) => def.aggregates.includes(a));
    case 'date':
      return def.filterModel === 'date';
    case 'people':
      return def.filterModel === 'people';
    case 'any':
      return def.filterModel !== 'files';
  }
};

/** How a widget counts: items, or a calculation over a number column. */
export const MEASURE_FNS = ['count', 'sum', 'avg', 'median', 'min', 'max'] as const;
export type MeasureFn = (typeof MEASURE_FNS)[number];
export const measureSchema = z
  .object({ fn: z.enum(MEASURE_FNS).default('count'), column: columnRefSchema.nullable().default(null) })
  .refine((m) => m.fn === 'count' || !!m.column, { message: 'measure_needs_column', path: ['column'] });
export type Measure = z.infer<typeof measureSchema>;

/** One calculation over numbers (the same as a group footer's — `summarize`). */
export const aggregateNumbers = (fn: MeasureFn, xs: number[]): number | null => {
  if (fn === 'count') return xs.length;
  if (!xs.length) return null;
  switch (fn) {
    case 'sum':
      return xs.reduce((s, x) => s + x, 0);
    case 'avg':
      return xs.reduce((s, x) => s + x, 0) / xs.length;
    case 'median': {
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
    }
    case 'min':
      return Math.min(...xs);
    case 'max':
      return Math.max(...xs);
  }
};

/**
 * A widget's own filter: rules on columns named by reference (each resolved per board). A board without a rule's
 * column contributes nothing — "status is Done" never counts a board that has no such status.
 */
export const widgetRuleSchema = z.object({
  column: columnRefSchema,
  operator: z.enum(FILTER_OPERATORS),
  values: z.array(z.unknown()).max(50).default([]),
});
export const widgetFilterSchema = z.object({
  operator: z.enum(['and', 'or']).default('and'),
  rules: z.array(widgetRuleSchema).max(20).default([]),
});
export type WidgetFilter = z.infer<typeof widgetFilterSchema>;

/** The widget filter as a board's query filter; null = the board lacks a column a rule needs. */
export const widgetFilterFor = (
  filter: WidgetFilter | undefined,
  boardId: string,
  columns: RefColumn[],
): FilterGroup | undefined | null => {
  if (!filter?.rules.length) return undefined;
  const rules: FilterRule[] = [];
  for (const r of filter.rules) {
    const key = resolveColumnRef(r.column, boardId, columns);
    if (!key) {
      if (filter.operator === 'and') return null;
      continue;
    }
    rules.push({ kind: 'rule', column_id: key, operator: r.operator, values: r.values, negate: false });
  }
  if (!rules.length) return null;
  return { kind: 'group', operator: filter.operator, negate: false, rules };
};

/** The dashboard-wide filter bar (applies to every widget): free text and a person, like a board's toolbar. */
export const dashboardFilterSchema = z.object({
  search: z.string().max(200).optional(),
  /** `me` / `user:<id>` / `team:<id>` on every people column. */
  person: z.string().max(80).optional(),
});
export type DashboardFilter = z.infer<typeof dashboardFilterSchema>;

/** Sources of a widget: some of the dashboard's boards, or (empty) all of them. */
export const widgetBoardsSchema = z.array(z.string()).max(50).default([]);

/**
 * Round 15: what a widget reads on each source board — its items, its subitems (the rows of its sub-board, D14,
 * with the sub-board's own columns), or both. Columns still meet by type + title, so a column that exists on the
 * board and on its sub-board is one column of the widget.
 */
export const WIDGET_SOURCES = ['items', 'subitems', 'both'] as const;
export type WidgetSource = (typeof WIDGET_SOURCES)[number];
export const widgetSourceSchema = z.enum(WIDGET_SOURCES).default('items');
export const sourceReadsItems = (s: WidgetSource | undefined) => s !== 'subitems';
export const sourceReadsSubitems = (s: WidgetSource | undefined) => s === 'subitems' || s === 'both';

/** Date buckets of a chart axis over a date column. */
export const WIDGET_DATE_UNITS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type WidgetDateUnit = (typeof WIDGET_DATE_UNITS)[number];

/** What a chart / breakdown groups by: a column, the source board, or the board's group (by its title). */
export const dimensionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('column'),
    column: columnRefSchema,
    date_unit: z.enum(WIDGET_DATE_UNITS).default('month'),
  }),
  z.object({ kind: z.literal('board') }),
  z.object({ kind: z.literal('group') }),
]);
export type Dimension = z.infer<typeof dimensionSchema>;

/** The bucket key of an ISO day (`YYYY-MM-DD`) for a unit — sortable as text. */
export const dateBucket = (day: string, unit: WidgetDateUnit, firstDay = 0): string => {
  const [y, m] = [day.slice(0, 4), Number(day.slice(5, 7))];
  switch (unit) {
    case 'day':
      return day.slice(0, 10);
    case 'month':
      return `${y}-${String(m).padStart(2, '0')}`;
    case 'quarter':
      return `${y}-Q${Math.ceil(m / 3)}`;
    case 'year':
      return y;
    case 'week': {
      const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
      const back = (d.getUTCDay() - firstDay + 7) % 7;
      d.setUTCDate(d.getUTCDate() - back);
      return d.toISOString().slice(0, 10);
    }
  }
};
