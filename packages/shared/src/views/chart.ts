// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { QueryEnv } from '../query/plan';
import { resolveField, type Field } from '../query/plan';
import { readDateSpan, readNumber } from '../query/evaluate';
import { EMPTY_BUCKET, groupRows } from '../query/group';
import type { QueryRow } from '../query/evaluate';
import { aggregateNumbers, dateBucket, MEASURE_FNS, WIDGET_DATE_UNITS } from '../widgets/common';
import { CHART_TYPES } from '../widgets/defs';

/**
 * The Chart view of a board (M8 ד9): the dashboard chart widget (same types, same data shape and the same
 * drawing), on one board, over the view's filtered items. Columns are this board's keys (a widget names them by
 * type + title because it reads several boards).
 */
export const chartDimensionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('column'),
    column_id: z.string().max(64),
    date_unit: z.enum(WIDGET_DATE_UNITS).default('month'),
  }),
  z.object({ kind: z.literal('group') }),
]);
export type ChartDimension = z.infer<typeof chartDimensionSchema>;

export const viewChartSchema = z.object({
  chart_type: z.enum(CHART_TYPES).default('bar'),
  /** The X axis (or the slices); default = the board's groups. */
  x: chartDimensionSchema.default({ kind: 'group' }),
  /** Stacked bars: what splits each bar. */
  series: chartDimensionSchema.nullable().default(null),
  measure: z
    .object({ fn: z.enum(MEASURE_FNS).default('count'), column_id: z.string().max(64).nullable().default(null) })
    .default({ fn: 'count', column_id: null }),
  max_buckets: z.number().int().min(2).max(30).default(12),
});
export type ViewChart = z.infer<typeof viewChartSchema>;

type Bucket = { key: string; label: string; color: string | null };
export type BoardChartData = {
  series: Bucket[];
  rows: (Bucket & { values: Record<string, number> })[];
  unit: string | null;
};

export type ChartContext = {
  /** The board's groups (id → title + a CSS colour). */
  groups: { id: string; title: string; color: string | null }[];
  /** People / team names for people buckets. */
  nameOf?: (id: string) => string | undefined;
};

const fieldOf = (id: string | null | undefined, env: QueryEnv): Field | null => {
  if (!id) return null;
  try {
    return resolveField(id, env);
  } catch {
    return null;
  }
};

const empty: Bucket = { key: EMPTY_BUCKET, label: '', color: null };

/** Every row's buckets on one axis (a multi-value column puts a row in each, like a board's group by). */
const bucketsOf = (rows: QueryRow[], dim: ChartDimension, env: QueryEnv, ctx: ChartContext) => {
  const out = new Map<string, Bucket[]>();
  const push = (id: string, b: Bucket) => out.set(id, [...(out.get(id) ?? []), b]);
  if (dim.kind === 'group') {
    const groups = new Map(ctx.groups.map((g) => [g.id, g]));
    for (const r of rows) {
      const g = r.group_id ? groups.get(r.group_id) : undefined;
      push(r.id, g ? { key: g.id, label: g.title, color: g.color } : empty);
    }
    return { of: (id: string) => out.get(id) ?? [], order: ctx.groups.map((g) => g.id), dated: false };
  }
  const f = fieldOf(dim.column_id, env);
  if (!f) return { of: () => [], order: [], dated: false };
  if (f.model === 'date') {
    for (const r of rows) {
      const span = readDateSpan(r, f, env.timezone);
      if (!span?.from) push(r.id, empty);
      else {
        const key = dateBucket(span.from, dim.date_unit, env.firstDay);
        push(r.id, { key, label: key, color: null });
      }
    }
    return { of: (id: string) => out.get(id) ?? [], order: [], dated: true };
  }
  const order: string[] = [];
  for (const g of groupRows(rows, f, { timezone: env.timezone, emptyLabel: '', nameOf: ctx.nameOf })) {
    order.push(g.key);
    for (const r of g.rows) push(r.id, { key: g.key, label: g.label, color: g.color ?? null });
  }
  return { of: (id: string) => out.get(id) ?? [], order, dated: false };
};

/**
 * Chart data of a board's rows: values per (bucket, series) — a count, or the measure over a number column.
 * More buckets than `max_buckets` fold into `__other__` (the biggest stay), like the widget.
 */
export const boardChartData = (
  rows: QueryRow[],
  chart: Partial<ViewChart> | undefined,
  env: QueryEnv,
  ctx: ChartContext,
): BoardChartData => {
  const s = viewChartSchema.parse(chart ?? {});
  const measureField = s.measure.fn === 'count' ? null : fieldOf(s.measure.column_id, env);
  const read = s.measure.fn === 'count' ? () => 1 : measureField ? (r: QueryRow) => readNumber(r, measureField) : null;
  const unitDef = measureField?.source === 'column' ? measureField : null;
  const unit = unitDef?.def.formatNumber ? unitDef.def.formatNumber(0, unitDef.settings) : null;
  if (!read) return { series: [], rows: [], unit };
  const x = bucketsOf(rows, s.x, env, ctx);
  const series = s.chart_type === 'stacked_bar' && s.series ? bucketsOf(rows, s.series, env, ctx) : null;
  const xs = new Map<string, Bucket & { n: number }>();
  const ss = new Map<string, Bucket>();
  const cells = new Map<string, number[]>();
  for (const r of rows) {
    const v = read(r);
    if (v === null) continue;
    const rowSeries = series ? series.of(r.id) : [{ key: 'value', label: '', color: null }];
    for (const xb of x.of(r.id)) {
      const xe = xs.get(xb.key) ?? { ...xb, n: 0 };
      xe.n++;
      xs.set(xb.key, xe);
      for (const sb of rowSeries) {
        if (!ss.has(sb.key)) ss.set(sb.key, sb);
        const k = `${xb.key}\u0000${sb.key}`;
        // S-30: push, never copy — one bucket of 250k rows copied per row froze the process (O(n²)).
        const list = cells.get(k);
        if (list) list.push(v);
        else cells.set(k, [v]);
      }
    }
  }
  let buckets = [...xs.values()];
  const last = (k: string) => (k === EMPTY_BUCKET ? 1 : 0);
  if (x.dated) buckets.sort((p, q) => last(p.key) - last(q.key) || (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
  else if (x.order.length) {
    const at = new Map(x.order.map((k, i) => [k, i]));
    buckets.sort((p, q) => (at.get(p.key) ?? 1e9) - (at.get(q.key) ?? 1e9));
  }
  let other: string[] = [];
  if (buckets.length > s.max_buckets) {
    const keep = new Set(
      [...buckets]
        .sort((p, q) => q.n - p.n)
        .slice(0, s.max_buckets - 1)
        .map((b) => b.key),
    );
    other = buckets.filter((b) => !keep.has(b.key)).map((b) => b.key);
    buckets = buckets.filter((b) => keep.has(b.key));
  }
  const seriesList = [...ss.values()];
  const valueAt = (keys: string[], sk: string) => {
    const vals = keys.flatMap((k) => cells.get(`${k}\u0000${sk}`) ?? []);
    return vals.length ? (aggregateNumbers(s.measure.fn, vals) ?? 0) : 0;
  };
  const out = buckets.map((b) => ({
    key: b.key,
    label: b.label,
    color: b.color,
    values: Object.fromEntries(seriesList.map((sb) => [sb.key, valueAt([b.key], sb.key)])),
  }));
  if (other.length)
    out.push({
      key: '__other__',
      label: '',
      color: null,
      values: Object.fromEntries(seriesList.map((sb) => [sb.key, valueAt(other, sb.key)])),
    });
  return { series: seriesList, rows: out, unit };
};
