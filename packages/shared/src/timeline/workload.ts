// SPDX-License-Identifier: AGPL-3.0-only
import type { IsoDate } from '../calendar';
import { addDays, type DateEnv } from '../query/dates';
import type { CalendarConfig } from '../workdays/settings';
import { dayWeight } from '../workdays/workdays';
import { daysBetween, startOfUnit, type Span } from './axis';

/**
 * Workload (M8 ד8, D25): per person (a people column) per day or week, how loaded they are. The measure is chosen
 * per view: the number of items, or a number / time-estimate column — an item's effort is spread evenly over its
 * working days (the account's weekend excluded — and, given the account calendar, its holidays and days off; an
 * item that lies only on days off uses its own days). Every
 * assignee carries the item's full effort. Capacity: a daily default for the view, overridable per
 * person; a week's capacity = daily × its working days.
 */

export const WORKLOAD_MEASURES = ['count', 'column'] as const;
export type WorkloadMeasure = (typeof WORKLOAD_MEASURES)[number];
export const WORKLOAD_UNITS = ['day', 'week'] as const;
/** Round 15: the rows a workload reads — the items, their subitems, or both. */
export const WORKLOAD_SOURCES = ['items', 'subitems', 'both'] as const;
export type WorkloadSource = (typeof WORKLOAD_SOURCES)[number];
export type WorkloadUnit = (typeof WORKLOAD_UNITS)[number];

/** The daily capacity a view starts with: 3 items, or 8 (hours) of a column. */
export const defaultCapacity = (measure: WorkloadMeasure) => (measure === 'count' ? 3 : 8);

export type WorkloadItem = {
  id: string;
  /** Assignees (user / team ids). */
  people: string[];
  span: Span | null;
  /** The effort of the column measure (null = none, counts 0); ignored when counting items. */
  effort: number | null;
};

export type WorkloadCell = { load: number; items: string[] };
/** person id → bucket start → load and the items behind it. */
export type WorkloadGrid = Map<string, Map<IsoDate, WorkloadCell>>;

/** How much a day counts toward work: the shared engine's weight ('workdays' with a calendar, else weekend only). */
const workWeight = (d: IsoDate, weekend: DateEnv['weekend'], calendar?: CalendarConfig) =>
  dayWeight(d, calendar ? 'workdays' : 'weekdays', calendar, weekend);

/**
 * The working days of a span (weekend excluded; with the account calendar, its days off too); a
 * span made only of days off keeps all its days.
 */
export const workingDays = (span: Span, weekend: DateEnv['weekend'], calendar?: CalendarConfig): IsoDate[] => {
  const all: IsoDate[] = [];
  const n = daysBetween(span.from, span.to);
  for (let i = 0; i <= n && i < 3660; i++) all.push(addDays(span.from, i));
  const work = all.filter((d) => workWeight(d, weekend, calendar) > 0);
  return work.length ? work : all;
};

/** The bucket a day falls in: the day itself, or its week's first day. */
export const bucketOf = (iso: IsoDate, unit: WorkloadUnit, firstDay: number) =>
  unit === 'day' ? iso : startOfUnit(iso, 'week', firstDay);

/** The buckets of a range, in order. */
export const workloadBuckets = (range: Span, unit: WorkloadUnit, firstDay: number): IsoDate[] => {
  const out: IsoDate[] = [];
  let cur = bucketOf(range.from, unit, firstDay);
  const step = unit === 'day' ? 1 : 7;
  for (let i = 0; cur <= range.to && i < 3660; i++) {
    out.push(cur);
    cur = addDays(cur, step);
  }
  return out;
};

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * The load of every person in every bucket of `range`. Counting: an item counts 1 in each bucket it is active in
 * (a working day of it falls there). Column: its effort / its working days, summed per bucket.
 */
export const aggregateWorkload = (p: {
  items: WorkloadItem[];
  measure: WorkloadMeasure;
  unit: WorkloadUnit;
  range: Span;
  weekend: DateEnv['weekend'];
  firstDay: number;
  /** The account calendar: its holidays and days off carry no work. */
  calendar?: CalendarConfig;
}): WorkloadGrid => {
  const grid: WorkloadGrid = new Map();
  for (const it of p.items) {
    if (!it.span || !it.people.length) continue;
    if (it.span.to < p.range.from || it.span.from > p.range.to) continue;
    const days = workingDays(it.span, p.weekend, p.calendar);
    const perDay = p.measure === 'count' ? 0 : (it.effort ?? 0) / days.length;
    const loads = new Map<IsoDate, number>();
    for (const d of days) {
      if (d < p.range.from || d > p.range.to) continue;
      const b = bucketOf(d, p.unit, p.firstDay);
      loads.set(b, p.measure === 'count' ? 1 : (loads.get(b) ?? 0) + perDay);
    }
    for (const person of new Set(it.people)) {
      const row = grid.get(person) ?? new Map<IsoDate, WorkloadCell>();
      grid.set(person, row);
      for (const [b, load] of loads) {
        const cell = row.get(b) ?? { load: 0, items: [] };
        cell.load = round(cell.load + load);
        cell.items.push(it.id);
        row.set(b, cell);
      }
    }
  }
  return grid;
};

/**
 * A bucket's capacity: the daily capacity × its working days (a day on the weekend — or, with the account calendar,
 * a day off — has none; a half day has half, as the account counts it).
 */
export const bucketCapacity = (
  bucket: IsoDate,
  unit: WorkloadUnit,
  perDay: number,
  weekend: DateEnv['weekend'],
  calendar?: CalendarConfig,
): number => {
  if (unit === 'day') return perDay * workWeight(bucket, weekend, calendar);
  let n = 0;
  for (let i = 0; i < 7; i++) n += workWeight(addDays(bucket, i), weekend, calendar);
  return perDay * n;
};

export type LoadLevel = 'none' | 'under' | 'full' | 'over';

/** How a load compares with its capacity (the cell's colour). A load on a day without capacity is "over". */
export const loadLevel = (load: number, capacity: number): LoadLevel => {
  if (load <= 0) return 'none';
  if (load > capacity) return 'over';
  return load === capacity ? 'full' : 'under';
};

/** A row a workload reads (round 15): an item, or a subitem with the row it sits under. */
export type WorkloadSourceRow<R> = { row: R; kind: 'item' | 'subitem'; parent: R | null };

/**
 * The rows of a workload's source: the items the view shows, their subitems (every depth, from the sub-board), or
 * both. A subitem counts while its top item is in the view (the view's filter narrows the subitems too); it keeps
 * its direct parent, so tooltips name it under that parent.
 */
export const workloadSourceRows = <R extends { id: string; parent_item_id: string | null }>(
  source: WorkloadSource,
  items: R[],
  subitems: R[],
): WorkloadSourceRow<R>[] => {
  const out: WorkloadSourceRow<R>[] = [];
  if (source !== 'subitems') for (const row of items) out.push({ row, kind: 'item', parent: null });
  if (source === 'items') return out;
  const shown = new Set(items.map((i) => i.id));
  const byId = new Map<string, R>();
  for (const r of items) byId.set(r.id, r);
  for (const r of subitems) byId.set(r.id, r);
  const topOf = (r: R): string => {
    let cur = r;
    for (let i = 0; i < 10 && cur.parent_item_id; i++) {
      const up = byId.get(cur.parent_item_id);
      if (!up) return cur.parent_item_id;
      cur = up;
    }
    return cur.id;
  };
  for (const row of subitems) {
    if (!row.parent_item_id || !shown.has(topOf(row))) continue;
    out.push({ row, kind: 'subitem', parent: byId.get(row.parent_item_id) ?? null });
  }
  return out;
};

/** A source row's name as tooltips show it: a subitem under its parent's name ("Parent › Subitem"). */
export const workloadRowLabel = <R extends { name: string }>(r: WorkloadSourceRow<R>) =>
  r.parent ? `${r.parent.name} › ${r.row.name}` : r.row.name;
