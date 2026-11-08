// SPDX-License-Identifier: AGPL-3.0-only
import {
  type DateEnv,
  RELATIVE_BUCKETS,
  type RelativeBucket,
  relativeDateBucket,
  WHEN_BUCKETS,
  type WhenBucket,
  whenBucket,
} from './dates';
import { readDateSpan, readIds, readNumber, readText, type QueryRow } from './evaluate';
import type { GroupBy, GroupDateUnit, GroupMode } from './filter';
import { dateBucket } from '../widgets/common';
import type { Field } from './plan';
import { formatDate, getRegion, type Region } from '../locale/format';
import { columnTypes } from '../columns';

/**
 * Group by a column (13-FILTERS §3–4): rows bucketed by value instead of by board group. Multi-value columns
 * (dropdown, people) put an item in every matching bucket. The empty bucket comes last.
 */
export type RowBucket<R> = { key: string; label: string; color?: string; rows: R[] };

export const EMPTY_BUCKET = '__empty__';

/** Column types that can be grouped by (13 §4.1) — everything but files. */
export const isGroupable = (f: Field) => f.model !== 'files';

type Label = { id: number; label: string; color?: string; index?: number };

/** The "kind" a column groups as: its own model, or — a mirror / formula — what its values are (ק2). */
type GroupKind = 'labels' | 'label' | 'people' | 'tags' | 'links' | 'number' | 'text' | 'other';

const kindOf = (field: Field): GroupKind => {
  if (field.source === 'system') return 'other';
  if (field.def.engine === 'mirror') {
    const source = field.column.mirror_source;
    const def = source ? columnTypes.get(source.type) : undefined;
    if (def?.aggregates.includes('labels')) return 'labels';
    if (def && (['sum', 'avg', 'min', 'max'] as const).some((a) => def.aggregates.includes(a))) return 'number';
    return 'text';
  }
  if (field.column.type === 'formula') return field.settings.result_type === 'number' ? 'number' : 'text';
  switch (field.model) {
    case 'label':
    case 'labels':
    case 'people':
    case 'tags':
    case 'links':
    case 'number':
    case 'text':
      return field.model;
    default:
      return 'other';
  }
};

/**
 * How a column can group (ק2) — the first is its default; none or one = nothing to choose. Labels by
 * their order or name; multi-values each or as a combination; people also by team; numbers in ranges (a rating
 * exactly); text exactly or by first letter, an email / link by domain, a phone / address by country.
 */
export const groupModes = (field: Field): GroupMode[] => {
  const kind = kindOf(field);
  const type = field.source === 'column' ? field.column.type : '';
  switch (kind) {
    case 'label':
      return ['each', 'name'];
    case 'labels':
    case 'tags':
      return ['each', 'combo'];
    case 'people':
      return ['each', 'combo', 'team'];
    case 'number':
      return type === 'rating' ? ['exact', 'ranges'] : ['ranges', 'exact'];
    case 'text':
      if (type === 'email' || type === 'link') return ['exact', 'domain', 'first_letter'];
      if (type === 'phone' || type === 'location') return ['exact', 'country'];
      // A country is already its own group.
      if (type === 'country') return [];
      return ['exact', 'first_letter'];
    default:
      return [];
  }
};

/** A round range size for these values: about eight ranges of 1, 2 or 5 × 10ⁿ. */
export const niceRangeSize = (min: number, max: number) => {
  const raw = (max - min) / 8;
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};

/** An email's domain, a link's host; '' when there is none. */
const domainOf = (text: string) => {
  const t = text.trim().toLowerCase();
  const at = t.lastIndexOf('@');
  if (at >= 0) return t.slice(at + 1);
  try {
    return new URL(/^https?:\/\//.test(t) ? t : `https://${t}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export const groupRows = <R extends QueryRow>(
  rows: R[],
  field: Field,
  opts: {
    timezone: string;
    direction?: 'asc' | 'desc';
    /** Display names for people, team and linked-item buckets. */
    nameOf?: (id: string) => string | undefined;
    emptyLabel: string;
    checkedLabel?: string;
    /**
     * How dates group and each bucket's label: `when` (the default — overdue, today, tomorrow …
     * with `pastDetail`, the past as last week / last month … — `relativeDateBucket`), or one bucket per day, week
     * (from the account's first day), month, quarter or year. `edge`: a timeline's start (default) or end. Without
     * it, one bucket per day labelled in the region's format.
     */
    dates?: {
      env: DateEnv;
      label: (key: string, unit: GroupDateUnit) => string;
      unit?: GroupDateUnit;
      pastDetail?: boolean;
      edge?: 'start' | 'end';
    };
    /** Day buckets are labelled in this region's date format (default: the runtime region). */
    region?: Region;
    /** How other columns group (`groupModes`; absent or not offered = the column's default). */
    mode?: GroupMode;
    /** `ranges`: the size of a range (absent = `niceRangeSize` of the values). */
    rangeSize?: number;
    /** Status / labels: a bucket for every label, also those with no rows. */
    showEmpty?: boolean;
    /** `team`: the account's teams (a person is in each of their teams). */
    teams?: { id: string; member_ids: string[] }[];
    /** `country`: a country's name from its code. */
    countryName?: (code: string) => string;
    /** The buckets' order by key, instead of by value (the board's groups as a level: the board's order). */
    rank?: (key: string) => number;
  },
): RowBucket<R>[] => {
  const buckets = new Map<string, RowBucket<R>>();
  const empty: RowBucket<R> = { key: EMPTY_BUCKET, label: opts.emptyLabel, rows: [] };
  const add = (key: string, label: string, row: R, color?: string) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { key, label, rows: [], ...(color ? { color } : {}) }));
    b.rows.push(row);
  };
  const labels = (
    field.source === 'column' && Array.isArray(field.settings.labels) ? field.settings.labels : []
  ) as Label[];
  /** Sort value per bucket key (label position, date, number, text). */
  const order = new Map<string, number | string>();
  const modes = groupModes(field);
  const mode = opts.mode && modes.includes(opts.mode) ? opts.mode : modes[0];
  const kind = kindOf(field);
  const nameOf = (id: string) => opts.nameOf?.(id) ?? id;

  // Numbers in ranges: the size comes from all the values (or the view's setting).
  const numberFormat = (() => {
    if (field.source !== 'column') return (n: number) => String(n);
    if (field.def.engine === 'mirror') {
      const source = field.column.mirror_source;
      const fmt = source ? columnTypes.get(source.type)?.formatNumber : undefined;
      return fmt ? (n: number) => fmt(n, source!.settings as never) : (n: number) => String(n);
    }
    const fmt = field.def.formatNumber;
    return fmt ? (n: number) => fmt(n, field.settings) : (n: number) => String(n);
  })();
  let rangeSize = 0;
  if (kind === 'number' && mode === 'ranges') {
    const xs = rows.map((r) => readNumber(r, field)).filter((n): n is number => n !== null);
    rangeSize = opts.rangeSize ?? (xs.length ? niceRangeSize(Math.min(...xs), Math.max(...xs)) : 1);
  }
  const combo = (ids: string[], name: (id: string) => string) => {
    const sorted = [...ids].sort();
    return { key: sorted.join('|'), label: sorted.map(name).join(' + ') };
  };

  for (const row of rows) {
    switch (kind) {
      case 'label':
      case 'labels': {
        // A mirror of labels carries them on its value (label, colour, count); a label column, ids.
        if (field.source === 'column' && field.def.engine === 'mirror') {
          const ls =
            (row.cells[field.id]?.value as { labels?: { label: string; color: string }[] } | null)?.labels ?? [];
          if (!ls.length) empty.rows.push(row);
          else if (mode === 'combo') {
            const c = combo(
              ls.map((l) => l.label),
              (x) => x,
            );
            add(`combo:${c.key}`, c.label, row);
            order.set(`combo:${c.key}`, c.label.toLowerCase());
          } else
            for (const l of ls) {
              add(l.label, l.label, row, l.color);
              order.set(l.label, l.label.toLowerCase());
            }
          break;
        }
        const ids = readIds(row, field);
        if (!ids.length) empty.rows.push(row);
        else if (mode === 'combo') {
          const c = combo(ids, (id) => labels.find((x) => String(x.id) === id)?.label ?? id);
          add(`combo:${c.key}`, c.label, row);
          order.set(`combo:${c.key}`, c.label.toLowerCase());
        } else
          for (const id of ids) {
            const l = labels.find((x) => String(x.id) === id);
            add(id, l?.label ?? id, row, l?.color);
            order.set(id, mode === 'name' ? (l?.label ?? id).toLowerCase() : (l?.index ?? labels.indexOf(l!)));
          }
        break;
      }
      case 'people':
      case 'tags': {
        const ids = readIds(row, field);
        if (!ids.length) empty.rows.push(row);
        else if (mode === 'combo') {
          const c = combo(ids, nameOf);
          add(`combo:${c.key}`, c.label, row);
          order.set(`combo:${c.key}`, c.label.toLowerCase());
        } else if (mode === 'team') {
          // A team in the cell is itself; a person is in each of their teams; nobody in a team = empty.
          const teams = new Set<string>();
          for (const id of ids)
            if (opts.teams?.some((t) => t.id === id)) teams.add(id);
            else for (const t of opts.teams ?? []) if (t.member_ids.includes(id)) teams.add(t.id);
          if (!teams.size) empty.rows.push(row);
          for (const id of teams) {
            add(id, nameOf(id), row);
            order.set(id, nameOf(id).toLowerCase());
          }
        } else
          for (const id of ids) {
            add(id, nameOf(id), row);
            order.set(id, nameOf(id).toLowerCase());
          }
        break;
      }
      case 'links': {
        // Each linked item: its name from the cell (`names`, aligned with the ids) or the caller.
        const ids = readIds(row, field);
        if (!ids.length) empty.rows.push(row);
        const names = (row.cells[field.id] as { names?: string[] } | undefined)?.names;
        ids.forEach((id, i) => {
          const name = opts.nameOf?.(id) ?? names?.[i] ?? id;
          add(id, name, row);
          order.set(id, name.toLowerCase());
        });
        break;
      }
      case 'number': {
        const n = readNumber(row, field);
        if (n === null) empty.rows.push(row);
        else if (mode === 'ranges') {
          const lo = Math.floor(n / rangeSize) * rangeSize;
          const key = String(lo);
          add(key, `${numberFormat(lo)} – ${numberFormat(lo + rangeSize)}`, row);
          order.set(key, lo);
        } else {
          const key = String(n);
          add(key, readText(row, field) || numberFormat(n), row);
          order.set(key, n);
        }
        break;
      }
      case 'text': {
        const text = readText(row, field).trim();
        const value = row.cells[field.id]?.value as { country?: string; country_code?: string } | null | undefined;
        const key =
          mode === 'first_letter'
            ? (text.at(0) ?? '').toLocaleUpperCase()
            : mode === 'domain'
              ? domainOf(text)
              : mode === 'country'
                ? (value?.country ?? value?.country_code ?? '').toUpperCase()
                : text.toLowerCase();
        if (!key) empty.rows.push(row);
        else {
          const label = mode === 'country' ? (opts.countryName?.(key) ?? key) : mode === 'exact' ? text : key;
          add(key, label, row);
          order.set(key, label.toLowerCase());
        }
        break;
      }
      default:
        switch (field.model) {
          case 'checkbox': {
            const checked = readText(row, field) !== '';
            if (checked) {
              add('checked', opts.checkedLabel ?? '✓', row);
              order.set('checked', 0);
            } else empty.rows.push(row);
            break;
          }
          case 'date': {
            const d = opts.dates;
            const span = (() => {
              try {
                return readDateSpan(row, field, opts.timezone, d?.edge === 'end' ? 'end' : 'start');
              } catch {
                return null;
              }
            })();
            if (!span?.from) empty.rows.push(row);
            else {
              const day = span.from;
              const unit = d?.unit ?? 'when';
              if (d && unit === 'when') {
                const b = d.pastDetail ? relativeDateBucket(day, d.env) : whenBucket(day, d.env);
                add(b, d.label(b, unit), row);
                order.set(
                  b,
                  d.pastDetail ? RELATIVE_BUCKETS.indexOf(b as RelativeBucket) : WHEN_BUCKETS.indexOf(b as WhenBucket),
                );
              } else if (d && unit !== 'when') {
                // Keys sort as text: 2026-10-13 · week start 2026-10-11 · 2026-10 · 2026-Q4 · 2026.
                const key = dateBucket(day, unit, d.env.firstDay);
                add(key, d.label(key, unit), row);
                order.set(key, key);
              } else {
                add(day, formatDate(day, {}, opts.region ?? getRegion()), row);
                order.set(day, day);
              }
            }
            break;
          }
          case 'ids': {
            const ids = readIds(row, field);
            if (!ids.length) empty.rows.push(row);
            for (const id of ids) {
              add(id, nameOf(id), row);
              order.set(id, nameOf(id).toLowerCase());
            }
            break;
          }
          case 'number': {
            const n = readNumber(row, field);
            if (n === null) empty.rows.push(row);
            else {
              add(String(n), String(n), row);
              order.set(String(n), n);
            }
            break;
          }
          default: {
            const text = readText(row, field).trim();
            if (!text) empty.rows.push(row);
            else {
              const key = text.toLowerCase();
              add(key, text, row);
              order.set(key, key);
            }
          }
        }
    }
  }

  // Every label, also those no row is on (planning) — in label order, empty sections included.
  if (opts.showEmpty && kind === 'label' && field.source === 'column' && field.def.engine !== 'mirror')
    for (const l of labels) {
      const id = String(l.id);
      if (!buckets.has(id)) {
        buckets.set(id, { key: id, label: l.label, rows: [], ...(l.color ? { color: l.color } : {}) });
        order.set(id, mode === 'name' ? l.label.toLowerCase() : (l.index ?? labels.indexOf(l)));
      }
    }

  const sign = opts.direction === 'desc' ? -1 : 1;
  const sorted = [...buckets.values()].sort((a, b) => {
    const x = opts.rank ? opts.rank(a.key) : order.get(a.key)!;
    const y = opts.rank ? opts.rank(b.key) : order.get(b.key)!;
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
  return empty.rows.length ? [...sorted, empty] : sorted;
};

/** One level of a nested grouping (ק3): its field and how it groups. */
export type GroupLevel = { field: Field; opts: Parameters<typeof groupRows>[2] };

/** A bucket of a nested grouping: its level (0 = the first), the keys down to it, and its sub-buckets. */
export type BucketNode<R> = RowBucket<R> & { level: number; path: string[]; children: BucketNode<R>[] };

/**
 * Group by up to three levels (ק3): each bucket of a level grouped again by the next.
 * The rows keep their order (the view's sort applies inside the deepest level); a row in two buckets of a level
 * (several people) is in both subtrees.
 */
export const groupTree = <R extends QueryRow>(
  rows: R[],
  levels: GroupLevel[],
  level = 0,
  path: string[] = [],
): BucketNode<R>[] => {
  const [first, ...rest] = levels;
  if (!first) return [];
  return groupRows(rows, first.field, first.opts).map((b) => {
    const at = [...path, b.key];
    return { ...b, level, path: at, children: rest.length ? groupTree(b.rows, rest, level + 1, at) : [] };
  });
};

/** Joins a nested bucket's keys into one section key (unit separator: never in a value). */
export const GROUP_PATH_SEP = '\u001f';

/** What a level's grouping (`GroupBy`) asks of `groupRows`, on top of the caller's names, labels and env. */
export const groupOptsOf = (
  g: Partial<GroupBy> | undefined,
  base: Omit<Parameters<typeof groupRows>[2], 'dates'> & {
    dates?: { env: DateEnv; label: (key: string, unit: GroupDateUnit) => string };
  },
): Parameters<typeof groupRows>[2] => ({
  ...base,
  direction: g?.direction,
  mode: g?.mode,
  rangeSize: g?.range_size,
  showEmpty: g?.show_empty,
  ...(base.dates
    ? { dates: { ...base.dates, unit: g?.date_unit, pastDetail: g?.past_detail, edge: g?.date_edge } }
    : {}),
});
