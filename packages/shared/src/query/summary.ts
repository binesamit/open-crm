// SPDX-License-Identifier: AGPL-3.0-only
import { EMPTY_STATUS_COLOR } from '../colors';
import { columnTypes } from '../columns';
import { readDateSpan, readIds, readNumber, readText, type QueryRow } from './evaluate';
import { aggregateNumbers } from '../widgets/common';
import type { Field } from './plan';

/**
 * Group footer summaries (11-UI §2, 12 M2): what each column type aggregates comes from its `aggregates` in the
 * registry — a status battery for labels, a sum/average for numbers and time, done counts for check boxes,
 * the earliest–latest range for dates. The view picks one per column (`summaries`), from the footer menu.
 */
export type ColumnSummary =
  | { kind: 'battery'; total: number; segments: { key: string; label: string; color: string; count: number }[] }
  | { kind: 'value'; fn: 'sum' | 'avg' | 'median' | 'min' | 'max' | 'count'; text: string }
  | { kind: 'done'; done: number; total: number; fn?: 'filled' }
  | { kind: 'range'; from: string; to: string; fn?: 'earliest' | 'latest' };

/** Every footer calculation; `filled` counts cells with a value, `none` leaves the footer cell empty. */
export const SUMMARY_FNS = [
  'battery',
  'done',
  'sum',
  'avg',
  'median',
  'min',
  'max',
  'count',
  'range',
  'earliest',
  'latest',
  'filled',
  'none',
] as const;
export type SummaryFn = (typeof SUMMARY_FNS)[number];

type Label = { id: number; label: string; color: string; index?: number };
const NUMERIC = ['sum', 'avg', 'median', 'min', 'max', 'count'] as const;
type ColumnField = Extract<Field, { source: 'column' }>;

/**
 * What a column's footer works from: its own type's aggregates and number format — or, for a mirror (prod
 *), its source column's, over the mirrored values: labels → the battery of the labels it carries, numbers →
 * sum / average … shown the source's way (a currency stays a currency; a mirror counting items shows plain counts).
 * A mirror of anything else (text, dates …) reads joined text: filled only.
 */
const footerBase = (field: ColumnField): { aggs: readonly string[]; format?: (n: number) => string } => {
  const own = field.def.formatNumber;
  if (field.def.engine !== 'mirror')
    return { aggs: field.def.aggregates, ...(own ? { format: (n: number) => own(n, field.settings) } : {}) };
  const source = field.column.mirror_source;
  const def = source ? columnTypes.get(source.type) : undefined;
  if (!source || !def) return { aggs: [] };
  if (def.aggregates.includes('labels')) return { aggs: ['labels'] };
  if (!NUMERIC.some((f) => f !== 'count' && def.aggregates.includes(f))) return { aggs: [] };
  if (field.settings.aggregate === 'count') return { aggs: ['sum', 'avg', 'count'] };
  const fmt = def.formatNumber;
  return { aggs: def.aggregates, ...(fmt ? { format: (n: number) => fmt(n, source.settings as never) } : {}) };
};

/** A mirror's labels on a row (r15cols: label, colour and how many of the linked items carry it). */
const mirrorLabels = (row: QueryRow, field: ColumnField) =>
  ((row.cells[field.id]?.value as { labels?: { label: string; color: string; count: number }[] } | null)?.labels ??
    []) as { label: string; color: string; count: number }[];

/** What a column's footer can show; the first option is its default. */
export const summaryOptions = (field: Field): SummaryFn[] => {
  if (field.source !== 'column') return [];
  const aggs = footerBase(field).aggs;
  if (aggs.includes('labels')) return ['battery', 'filled', 'none'];
  if (aggs.includes('count_done')) return ['done', 'none'];
  if (NUMERIC.some((f) => f !== 'count' && aggs.includes(f))) {
    // A number column's own `footer` setting leads, so existing boards keep what they showed.
    // Otherwise the type's first aggregate does (rating → average).
    const footer = field.settings.footer as SummaryFn | undefined;
    const fns: SummaryFn[] = [...NUMERIC, 'none'];
    const first = fns.includes(footer!) ? footer! : NUMERIC.find((f) => f !== 'count' && aggs.includes(f))!;
    return [first, ...fns.filter((f) => f !== first)];
  }
  if (aggs.includes('range')) return ['range', 'earliest', 'latest', 'filled', 'none'];
  return ['none', 'filled'];
};

export const summarize = (field: Field, rows: QueryRow[], timezone: string, choice?: string): ColumnSummary | null => {
  if (field.source !== 'column' || !rows.length) return null;
  const options = summaryOptions(field);
  const fn = options.find((o) => o === choice) ?? options[0]!;

  switch (fn) {
    case 'none':
      return null;
    case 'battery': {
      if (field.def.engine === 'mirror') {
        // Every label of every linked item, counted once per item it is on; a row with none is the empty part.
        const counts = new Map<string, { label: string; color: string; count: number }>();
        let empty = 0;
        for (const r of rows) {
          const ls = mirrorLabels(r, field);
          if (!ls.length) empty += 1;
          for (const l of ls) {
            const k = `${l.label}\u0000${l.color}`;
            const hit = counts.get(k);
            if (hit) hit.count += l.count;
            else counts.set(k, { ...l });
          }
        }
        const segments = [...counts].map(([key, l]) => ({ key, ...l }));
        if (empty) segments.push({ key: '', label: '', color: EMPTY_STATUS_COLOR, count: empty });
        return { kind: 'battery', total: segments.reduce((s, x) => s + x.count, 0), segments };
      }
      const labels = (Array.isArray(field.settings.labels) ? field.settings.labels : []) as Label[];
      const counts = new Map<string, number>();
      for (const r of rows) {
        const id = readIds(r, field)[0] ?? '';
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const segments = [...counts]
        .map(([key, count]) => {
          const l = labels.find((x) => String(x.id) === key);
          return {
            key,
            label: l?.label ?? '',
            color: l?.color ?? EMPTY_STATUS_COLOR,
            count,
            order: l ? (l.index ?? labels.indexOf(l)) : Number.MAX_SAFE_INTEGER,
          };
        })
        .sort((a, b) => a.order - b.order)
        .map(({ order: _order, ...s }) => s);
      return { kind: 'battery', total: rows.length, segments };
    }
    case 'done':
    case 'filled': {
      const done = rows.filter((r) => readText(r, field) !== '').length;
      return fn === 'filled'
        ? { kind: 'done', fn, done, total: rows.length }
        : { kind: 'done', done, total: rows.length };
    }
    case 'range':
    case 'earliest':
    case 'latest': {
      let from: string | null = null;
      let to: string | null = null;
      for (const r of rows) {
        const d = readDateSpan(r, field, timezone);
        if (!d) continue;
        if (!from || d.from! < from) from = d.from;
        if (!to || d.to! > to) to = d.to;
      }
      if (!from || !to) return null;
      if (fn === 'earliest') return { kind: 'range', fn, from, to: from };
      if (fn === 'latest') return { kind: 'range', fn, from: to, to };
      return { kind: 'range', from, to };
    }
    default: {
      const xs = rows.map((r) => readNumber(r, field)).filter((n): n is number => n !== null);
      if (!xs.length) return null;
      // One numeric aggregate for the summary row and the dashboard widgets (duplication #20).
      const v = aggregateNumbers(fn, xs)!;
      const format = footerBase(field).format;
      const text = fn === 'count' ? String(v) : (format?.(v) ?? String(Math.round(v * 100) / 100));
      return { kind: 'value', fn, text };
    }
  }
};
