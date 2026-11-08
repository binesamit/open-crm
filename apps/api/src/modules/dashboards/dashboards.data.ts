// SPDX-License-Identifier: AGPL-3.0-only
import {
  accountSettingsSchema,
  aggregateNumbers,
  AppError,
  type CalendarConfig,
  columnTypes,
  type ColumnRef,
  dateBucket,
  dateInZone,
  type DateToken,
  type DashboardFilter,
  type Dimension,
  EMPTY_BUCKET,
  EMPTY_STATUS_COLOR,
  type Field,
  type FilterGroup,
  groupRows,
  type Measure,
  type Query,
  type QueryEnv,
  type QueryRow,
  querySchema,
  readDateSpan,
  readIds,
  parseWidgetSettings,
  readNumber,
  readText,
  readWidgetSettings,
  resolveDateValue,
  resolveColumnRef,
  resolveField,
  sourceReadsItems,
  sourceReadsSubitems,
  summarize,
  type TimeReportQuery,
  viewSettingsSchema,
  type WidgetFilter,
  WIDGET_ITEMS_PAGE,
  widgetFilterFor,
  type WidgetItems,
  type WidgetPick,
  type WidgetSource,
  widgetTypes,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { accountCalendar } from '../../lib/account-calendar';
import { getAccountSettings } from '../accounts/accounts.repo';
import { assertBoard, loadBoardAccess } from '../boards/boards.access';
import { findSubBoard, listGroups, type ColumnRow } from '../boards/boards.repo';
import { itemsByIds } from '../items/items.repo';
import { calculatorFor, visibleColumns } from '../items/items.service';
import { queryItems } from '../items/query.service';
import { loadReportEntries } from '../time/report.service';
import { findView } from '../views/views.repo';
import { assertDashboard, loadDashboardAccess } from './dashboards.access';
import { findWidget, principalNames, type WidgetRow } from './dashboards.repo';
import { dashboardSettingsOf, sourceBoards } from './dashboards.service';
import type { Actor } from '../../types';

/**
 * Widget data (M8 ד4–ד5, plan §3.4): computed on the server for the viewer — every source board through
 * `queryItems` (its access, `view_items` rule and column restrictions), then aggregated with the same engine as
 * the board's group footers (`summarize`, `groupRows`). A board the viewer cannot read adds nothing and is only
 * counted. Columns of different boards meet by type + title (or the key chosen per board).
 */

/** Items read per source board for aggregates (plan: limited result size). */
export const WIDGET_ROWS_PER_BOARD = 5000;
const DATED_MAX = 1000;

type Env = {
  timezone: string;
  today: string;
  firstDay: number;
  weekend: 'fri_sat' | 'sat_sun';
  meId: string;
  /** The account calendar: "working days" filters skip its holidays too. */
  calendar?: CalendarConfig;
};

type BoardRows = {
  /** The board read: a source board, or its sub-board (round 15 — subitems). */
  board: { id: string; name: string };
  /** The source board it belongs to (the "board" dimension and the table's board name). */
  top: { id: string; name: string };
  /** Subitem → its direct parent's name (subitem rows only). */
  parents: Map<string, string>;
  columns: ColumnRow[];
  refColumns: { id: string; type: string; title: string }[];
  rows: QueryRow[];
  groups: Map<string, { title: string; color: string | null }>;
  truncated: boolean;
  queryEnv: QueryEnv;
};

const loadEnv = async (db: Db, a: Actor): Promise<Env> => {
  const s = accountSettingsSchema.parse(await getAccountSettings(db, a.ctx.accountId));
  const { timezone, weekend, first_day } = s.locale;
  const calendar = await accountCalendar(db, a.ctx.accountId, s);
  return { timezone, today: dateInZone(new Date(), timezone), firstDay: first_day, weekend, meId: a.user.id, calendar };
};

/** The boards a widget reads: its own choice among the dashboard's sources, or all of them. */
const widgetBoardIds = (dashboardBoards: string[], settings: { board_ids?: string[] }) => {
  const chosen = (settings.board_ids ?? []).filter((id) => dashboardBoards.includes(id));
  return chosen.length ? chosen : dashboardBoards;
};

type RowsOptions = {
  limit?: number;
  /** The board read is a sub-board (subitems at every depth) of `top`. */
  sub?: boolean;
  /** More conditions on the board's own columns (a board view's filter, round 15). */
  extra?: FilterGroup;
  /** Subitems only under these top items (the items a board view shows). */
  under?: Set<string> | null;
};

const both = (x: FilterGroup | undefined, y: FilterGroup | undefined): FilterGroup | undefined =>
  x && y ? { kind: 'group', operator: 'and', negate: false, rules: [x, y] } : (x ?? y);

/** One board's matching items, as the viewer may see them, with what resolving columns needs. */
const boardRows = async (
  db: Db,
  a: Actor,
  env: Env,
  board: { id: string; name: string },
  top: { id: string; name: string },
  filter: WidgetFilter | undefined,
  bar: DashboardFilter,
  opts: RowsOptions = {},
): Promise<BoardRows | null> => {
  const access = await loadBoardAccess(db, a.ctx, a.user, board.id);
  const columns = await visibleColumns(db, access);
  const refColumns = columns.map((c) => ({ id: c.key, type: c.type, title: c.title }));
  const group = widgetFilterFor(filter, board.id, refColumns);
  if (group === null) return null;
  const where = both(group, opts.extra);
  const query = querySchema.parse({
    ...(where ? { filter: where } : {}),
    ...(bar.search?.trim() ? { search: bar.search.trim() } : {}),
    ...(bar.person ? { person: bar.person } : {}),
    // A sub-board's rows are all subitems (depth ≥ 1).
    scope: opts.sub ? 'all' : 'parents',
    // Saved widget / view filters: a rule that no longer applies is skipped, not a failed widget.
    ignore_invalid_rules: true,
  });
  const res = await queryItems(db, a, board.id, query, { limit: opts.limit ?? WIDGET_ROWS_PER_BOARD });
  let rows = res.data as QueryRow[];
  const parents = new Map<string, string>();
  if (opts.sub && rows.length) {
    // Each subitem's top item (a board view keeps those under its items) and its direct parent's name.
    const own = new Map(
      (
        await itemsByIds(
          db,
          a.ctx.accountId,
          rows.map((r) => r.id),
        )
      ).map((r) => [r.id, r]),
    );
    if (opts.under) {
      const under = opts.under;
      rows = rows.filter((r) => {
        const it = own.get(r.id);
        return !!it && under.has(it.rootItemId ?? it.parentItemId ?? '');
      });
    }
    const parentIds = [...new Set(rows.map((r) => r.parent_item_id).filter((x): x is string => !!x))];
    const names = new Map((await itemsByIds(db, a.ctx.accountId, parentIds)).map((r) => [r.id, r.name]));
    for (const r of rows) if (r.parent_item_id) parents.set(r.id, names.get(r.parent_item_id) ?? '');
  }
  const groups = new Map((await listGroups(db, board.id)).map((g) => [g.id, { title: g.title, color: g.color }]));
  return {
    board,
    top,
    parents,
    columns,
    refColumns,
    rows,
    groups,
    truncated: res.total > res.data.length,
    queryEnv: {
      columns: columns.map((c) => ({ id: c.key, type: c.type, settings: c.settings as Record<string, unknown> })),
      meId: env.meId,
      today: env.today,
      timezone: env.timezone,
      weekend: env.weekend,
      firstDay: env.firstDay,
      calendar: env.calendar,
    },
  };
};

const fieldOf = (b: BoardRows, ref: ColumnRef | null | undefined): Field | null => {
  if (!ref) return null;
  const key = resolveColumnRef(ref, b.board.id, b.refColumns);
  if (!key) return null;
  try {
    return resolveField(key, b.queryEnv);
  } catch {
    return null;
  }
};

type Label = { id: number; label: string; color?: string };
const labelOf = (f: Field, id: string) =>
  f.source === 'column' && Array.isArray(f.settings.labels)
    ? (f.settings.labels as Label[]).find((l) => String(l.id) === id)
    : undefined;

/** The first label of a row in a status / dropdown column: text and colour. */
const rowLabel = (f: Field | null, row: QueryRow) => {
  if (!f) return null;
  const id = readIds(row, f)[0];
  const l = id ? labelOf(f, id) : undefined;
  return l ? { label: l.label, color: l.color ?? EMPTY_STATUS_COLOR } : null;
};

/** A measure's number for one row (null = the row adds nothing, e.g. an empty cell). */
const measureOf = (b: BoardRows, m: Measure) => {
  if (m.fn === 'count') return () => 1;
  const f = fieldOf(b, m.column);
  return f ? (row: QueryRow) => readNumber(row, f) : null;
};

const unitOf = (all: BoardRows[], m: Measure) => {
  if (m.fn === 'count') return null;
  for (const b of all) {
    const f = fieldOf(b, m.column);
    if (f?.source === 'column' && f.def.formatNumber) return { def: f.def, settings: f.settings };
  }
  return null;
};

const formatMeasure = (all: BoardRows[], m: Measure, v: number | null) => {
  if (v === null) return '';
  const u = unitOf(all, m);
  return u?.def.formatNumber ? u.def.formatNumber(v, u.settings) : String(Math.round(v * 100) / 100);
};

type Bucket = { key: string; label: string; color: string | null };

/** The buckets one row falls in for a dimension (a multi-value column puts it in each, like a board's group by). */
const bucketer = async (db: Db, a: Actor, env: Env, all: BoardRows[], dim: Dimension, emptyLabel = '') => {
  const out = new Map<string, Map<string, Bucket[]>>(); // board → row → buckets
  for (const b of all) {
    const rowBuckets = new Map<string, Bucket[]>();
    const push = (rowId: string, bucket: Bucket) => rowBuckets.set(rowId, [...(rowBuckets.get(rowId) ?? []), bucket]);
    if (dim.kind === 'board') for (const r of b.rows) push(r.id, { key: b.top.id, label: b.top.name, color: null });
    else if (dim.kind === 'group')
      for (const r of b.rows) {
        const g = r.group_id ? b.groups.get(r.group_id) : undefined;
        push(
          r.id,
          g ? { key: g.title.trim().toLocaleLowerCase(), label: g.title, color: g.color } : emptyBucket(emptyLabel),
        );
      }
    else {
      const f = fieldOf(b, dim.column);
      if (!f) continue;
      if (f.model === 'date') {
        for (const r of b.rows) {
          const span = readDateSpan(r, f, env.timezone);
          if (!span?.from) push(r.id, emptyBucket(emptyLabel));
          else {
            const key = dateBucket(span.from, dim.date_unit, env.firstDay);
            push(r.id, { key, label: key, color: null });
          }
        }
      } else {
        const ids = f.model === 'people' ? [...new Set(b.rows.flatMap((r) => readIds(r, f)))] : [];
        const names = await principalNames(db, a.ctx.accountId, ids);
        for (const g of groupRows(b.rows, f, {
          timezone: env.timezone,
          emptyLabel,
          nameOf: (id) => names.get(id),
        })) {
          // People are the same person on every board; labels and text meet by their text.
          const key =
            g.key === EMPTY_BUCKET
              ? EMPTY_BUCKET
              : f.model === 'people' || f.model === 'tags'
                ? g.key
                : g.label.trim().toLocaleLowerCase();
          for (const r of g.rows) push(r.id, { key, label: g.label, color: g.color ?? null });
        }
      }
    }
    out.set(b.board.id, rowBuckets);
  }
  return (boardId: string, rowId: string) => out.get(boardId)?.get(rowId) ?? [];
};

const emptyBucket = (label: string): Bucket => ({ key: EMPTY_BUCKET, label, color: null });

// ---- handlers per widget type (a map keyed by type — the registry's server half) ----
type Ctx = {
  db: Db;
  a: Actor;
  env: Env;
  boards: { id: string; name: string }[];
  bar: DashboardFilter;
  /** A board Dashboard view's filter on its board's items (round 15); its search / person are in `bar`. */
  view?: { filter?: FilterGroup; narrows: boolean };
};
type Handler = (c: Ctx, settings: Record<string, unknown>) => Promise<{ data: unknown; truncated: boolean }>;

/**
 * The rows of a widget: on every source board its items, its subitems (the sub-board — its own access, columns and
 * rules apply), or both (round 15). Under a board view's filter, subitems count while their item is in the view.
 */
const collect = async (c: Ctx, s: { filter?: WidgetFilter; source?: WidgetSource }) => {
  const out: BoardRows[] = [];
  for (const b of c.boards) {
    if (sourceReadsItems(s.source)) {
      const r = await boardRows(c.db, c.a, c.env, b, b, s.filter, c.bar, { extra: c.view?.filter });
      if (r) out.push(r);
    }
    if (!sourceReadsSubitems(s.source)) continue;
    const sub = await findSubBoard(c.db, b.id);
    if (!sub) continue;
    let under: Set<string> | null = null;
    let bar = c.bar;
    if (c.view?.narrows) {
      // The items the view shows (its filter, search and person) — the subitems under them count.
      const shown = await queryItems(
        c.db,
        c.a,
        b.id,
        querySchema.parse({
          ...(c.view.filter ? { filter: c.view.filter } : {}),
          ...(c.bar.search?.trim() ? { search: c.bar.search.trim() } : {}),
          ...(c.bar.person ? { person: c.bar.person } : {}),
          scope: 'parents',
          ignore_invalid_rules: true,
        }),
        { limit: WIDGET_ROWS_PER_BOARD },
      );
      under = new Set(shown.data.map((r) => r.id));
      bar = {};
    }
    const r = await boardRows(c.db, c.a, c.env, { id: sub.id, name: b.name }, b, s.filter, bar, { sub: true, under });
    if (r) out.push(r);
  }
  return { all: out, truncated: out.some((r) => r.truncated) };
};

const numbers: Handler = async (c, settings) => {
  const s = settings as { measure: Measure; filter?: WidgetFilter };
  const { all, truncated } = await collect(c, s);
  const xs: number[] = [];
  const perBoard = all.map((b) => {
    const read = measureOf(b, s.measure);
    const values = read ? b.rows.map(read).filter((n): n is number => n !== null) : [];
    xs.push(...values);
    return { board_id: b.board.id, value: aggregateNumbers(s.measure.fn, values), items: b.rows.length };
  });
  const value = aggregateNumbers(s.measure.fn, xs);
  return {
    data: {
      value,
      text: s.measure.fn === 'count' ? String(value ?? 0) : formatMeasure(all, s.measure, value),
      items: all.reduce((n, b) => n + b.rows.length, 0),
      per_board: perBoard,
    },
    truncated,
  };
};

const battery: Handler = async (c, settings) => {
  const s = settings as { column: ColumnRef | null; filter?: WidgetFilter };
  const { all, truncated } = await collect(c, s);
  const merged = new Map<string, { key: string; label: string; color: string | null; count: number }>();
  let total = 0;
  for (const b of all) {
    const f = fieldOf(b, s.column);
    if (!f) continue;
    // The group footer's battery (`summarize`), merged across boards by label text.
    const sum = summarize(f, b.rows, c.env.timezone, 'battery');
    if (sum?.kind !== 'battery') continue;
    total += sum.total;
    for (const seg of sum.segments) {
      const key = seg.label ? seg.label.trim().toLocaleLowerCase() : EMPTY_BUCKET;
      const m = merged.get(key) ?? {
        key,
        label: seg.label,
        color: seg.label ? seg.color : EMPTY_STATUS_COLOR,
        count: 0,
      };
      m.count += seg.count;
      merged.set(key, m);
    }
  }
  const segments = [...merged.values()].sort((x, y) => (x.key === EMPTY_BUCKET ? 1 : y.key === EMPTY_BUCKET ? -1 : 0));
  return { data: { total, segments }, truncated };
};

/** Values per (bucket, series) with a measure: counts or the calculation over the numbers in each cell. */
const crossTab = async (c: Ctx, all: BoardRows[], x: Dimension, series: Dimension | null, m: Measure, max: number) => {
  const xOf = await bucketer(c.db, c.a, c.env, all, x);
  const sOf = series ? await bucketer(c.db, c.a, c.env, all, series) : null;
  const xs = new Map<string, Bucket & { n: number }>();
  const ss = new Map<string, Bucket>();
  const cells = new Map<string, number[]>();
  for (const b of all) {
    const read = measureOf(b, m);
    if (!read) continue;
    for (const r of b.rows) {
      const v = read(r);
      if (v === null) continue;
      const rowSeries = sOf ? sOf(b.board.id, r.id) : [{ key: 'value', label: '', color: null }];
      for (const xb of xOf(b.board.id, r.id)) {
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
  }
  const dated = x.kind === 'column' && [...xs.keys()].some((k) => /^\d{4}/.test(k));
  let buckets = [...xs.values()];
  if (dated)
    buckets.sort((p, q) => (p.key === EMPTY_BUCKET ? 1 : q.key === EMPTY_BUCKET ? -1 : p.key < q.key ? -1 : 1));
  else if (x.kind === 'board')
    buckets.sort((p, q) => all.findIndex((b) => b.board.id === p.key) - all.findIndex((b) => b.board.id === q.key));
  // More buckets than fit: the biggest stay, the rest fold into one "other" bucket.
  let other: string[] = [];
  if (buckets.length > max) {
    const keep = new Set(
      [...buckets]
        .sort((p, q) => q.n - p.n)
        .slice(0, max - 1)
        .map((bk) => bk.key),
    );
    other = buckets.filter((bk) => !keep.has(bk.key)).map((bk) => bk.key);
    buckets = buckets.filter((bk) => keep.has(bk.key));
  }
  const seriesList = [...ss.values()];
  const valueAt = (keys: string[], sk: string) => {
    const vals = keys.flatMap((k) => cells.get(`${k}\u0000${sk}`) ?? []);
    return vals.length ? (aggregateNumbers(m.fn, vals) ?? 0) : 0;
  };
  const rows = buckets.map((bk) => ({
    key: bk.key,
    label: bk.label,
    color: bk.color,
    values: Object.fromEntries(seriesList.map((sb) => [sb.key, valueAt([bk.key], sb.key)])),
  }));
  if (other.length)
    rows.push({
      key: '__other__',
      label: '',
      color: null,
      values: Object.fromEntries(seriesList.map((sb) => [sb.key, valueAt(other, sb.key)])),
    });
  return { series: seriesList, rows };
};

const chart: Handler = async (c, settings) => {
  const s = settings as {
    chart_type: string;
    x: Dimension;
    series: Dimension | null;
    measure: Measure;
    max_buckets: number;
    filter?: WidgetFilter;
  };
  const { all, truncated } = await collect(c, s);
  const series = s.chart_type === 'stacked_bar' ? s.series : null;
  const tab = await crossTab(c, all, s.x, series, s.measure, s.max_buckets);
  return { data: { ...tab, unit: unitOf(all, s.measure) ? formatMeasure(all, s.measure, 0) : null }, truncated };
};

const tableRows = (b: BoardRows, fields: (Field | null)[], limit: number) =>
  b.rows.slice(0, limit).map((r) => ({
    id: r.id,
    // A subitem opens over its top board (like the board's own subitem rows).
    board_id: b.top.id,
    board_name: b.top.name,
    name: r.name,
    parent_name: b.parents.get(r.id) ?? null,
    cells: fields.map((f) => {
      if (!f) return null;
      const lab = f.model === 'label' || f.model === 'labels' ? rowLabel(f, r) : null;
      return { text: readText(r, f), color: lab?.color ?? null };
    }),
  }));

const table: Handler = async (c, settings) => {
  const s = settings as { columns: ColumnRef[]; limit: number; filter?: WidgetFilter };
  const { all, truncated } = await collect(c, s);
  const rows = all.flatMap((b) =>
    tableRows(
      b,
      s.columns.map((ref) => fieldOf(b, ref)),
      s.limit,
    ),
  );
  const total = all.reduce((n, b) => n + b.rows.length, 0);
  return {
    data: {
      columns: s.columns.map((ref) => ({ title: ref.title, type: ref.type })),
      rows: rows.slice(0, s.limit),
      total,
    },
    truncated,
  };
};

const dated: Handler = async (c, settings) => {
  const s = settings as { date_column: ColumnRef | null; color_column: ColumnRef | null; filter?: WidgetFilter };
  const { all, truncated } = await collect(c, s);
  const items = [];
  for (const b of all) {
    const f = fieldOf(b, s.date_column);
    if (!f) continue;
    const cf = fieldOf(b, s.color_column);
    for (const r of b.rows) {
      const span = readDateSpan(r, f, c.env.timezone);
      if (!span?.from) continue;
      const lab = rowLabel(cf, r);
      items.push({
        id: r.id,
        board_id: b.top.id,
        name: r.name,
        parent_name: b.parents.get(r.id) ?? null,
        from: span.from,
        to: span.to ?? span.from,
        color: lab?.color ?? null,
        label: lab?.label ?? null,
      });
    }
  }
  items.sort((p, q) => (p.from < q.from ? -1 : p.from > q.from ? 1 : 0));
  return {
    data: { items: items.slice(0, DATED_MAX), total: items.length },
    truncated: truncated || items.length > DATED_MAX,
  };
};

const workload: Handler = async (c, settings) => {
  const s = settings as {
    people_column: ColumnRef | null;
    measure: Measure;
    split_column: ColumnRef | null;
    filter?: WidgetFilter;
  };
  const { all, truncated } = await collect(c, s);
  const people = new Map<string, { id: string; values: Map<string, number[]> }>();
  const series = new Map<string, { key: string; label: string; color: string | null }>();
  for (const b of all) {
    const pf = fieldOf(b, s.people_column);
    const read = measureOf(b, s.measure);
    if (!pf || !read) continue;
    const sf = fieldOf(b, s.split_column);
    for (const r of b.rows) {
      const v = read(r);
      if (v === null) continue;
      const lab = sf ? rowLabel(sf, r) : null;
      const sk = sf ? (lab ? lab.label.trim().toLocaleLowerCase() : EMPTY_BUCKET) : 'value';
      if (!series.has(sk))
        series.set(sk, { key: sk, label: lab?.label ?? '', color: sf ? (lab?.color ?? EMPTY_STATUS_COLOR) : null });
      const ids = readIds(r, pf);
      for (const pid of ids.length ? ids : [EMPTY_BUCKET]) {
        const p = people.get(pid) ?? { id: pid, values: new Map() };
        const list = p.values.get(sk); // S-30: push, not copy (O(n²))
        if (list) list.push(v);
        else p.values.set(sk, [v]);
        people.set(pid, p);
      }
    }
  }
  const names = await principalNames(
    c.db,
    c.a.ctx.accountId,
    [...people.keys()].filter((k) => k !== EMPTY_BUCKET),
  );
  const list = [...people.values()].map((p) => {
    const values = Object.fromEntries([...p.values].map(([k, xs]) => [k, aggregateNumbers(s.measure.fn, xs) ?? 0]));
    const allXs = [...p.values.values()].flat();
    return { id: p.id, name: names.get(p.id) ?? '', total: aggregateNumbers(s.measure.fn, allXs) ?? 0, values };
  });
  list.sort((p, q) => (p.id === EMPTY_BUCKET ? 1 : q.id === EMPTY_BUCKET ? -1 : q.total - p.total));
  return {
    data: {
      series: [...series.values()],
      people: list,
      unit: unitOf(all, s.measure) ? formatMeasure(all, s.measure, 0) : null,
    },
    truncated,
  };
};

// ---- time report (ד5): the board report of every source, together ----
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Report ranges that are one date token (the filters' own definitions — 13 §2). */
const RANGE_TOKENS: Record<string, DateToken> = {
  today: 'TODAY',
  yesterday: 'YESTERDAY',
  this_week: 'THIS_WEEK',
  last_week: 'LAST_WEEK',
  this_month: 'THIS_MONTH',
  last_month: 'LAST_MONTH',
  this_quarter: 'THIS_QUARTER',
  last_quarter: 'LAST_QUARTER',
  this_year: 'THIS_YEAR',
  last_year: 'LAST_YEAR',
};
const LAST_DAYS: Record<string, number> = { last_7: 7, last_30: 30, last_90: 90 };

/** The days of a report range in the account's calendar (today in its timezone, its first day of the week). */
export const reportRange = (
  range: string,
  env: Pick<Env, 'today' | 'firstDay'> & Partial<Pick<Env, 'timezone' | 'weekend'>>,
  custom: { from: string | null; to: string | null },
): { from?: string; to?: string } => {
  const dateEnv = {
    today: env.today,
    firstDay: env.firstDay,
    timezone: env.timezone ?? 'UTC',
    weekend: env.weekend ?? 'fri_sat',
  };
  const token = RANGE_TOKENS[range];
  if (token) {
    const span = resolveDateValue(token, dateEnv)!;
    return { from: span.from!, to: span.to! };
  }
  const days = LAST_DAYS[range];
  if (days) return { from: addDays(env.today, -(days - 1)), to: env.today };
  if (range === 'custom')
    return { ...(custom.from ? { from: custom.from } : {}), ...(custom.to ? { to: custom.to } : {}) };
  return {};
};

const timeReport: Handler = async (c, settings) => {
  const s = settings as {
    group_by: 'user' | 'board' | 'item' | 'day' | 'column';
    column: ColumnRef | null;
    range: string;
    from: string | null;
    to: string | null;
    billable_only: boolean;
  };
  const range = reportRange(s.range, c.env, { from: s.from, to: s.to });
  const q = { group_by: 'user', ...range } as TimeReportQuery;
  const groups = new Map<
    string,
    { key: string; label: string; duration_s: number; billable_s: number; entries: number }
  >();
  let running = 0;
  for (const b of c.boards) {
    const entries = (await loadReportEntries(c.db, c.a, b.id, q)).filter((e) => !s.billable_only || e.entry.billable);
    // group_by column (a client column…): the value on the top-level item, as the viewer may see it.
    let cellText = new Map<string, string>();
    if (s.group_by === 'column' && s.column) {
      const access = await loadBoardAccess(c.db, c.a.ctx, c.a.user, b.id);
      const cols = await visibleColumns(c.db, access);
      const key = resolveColumnRef(
        s.column,
        b.id,
        cols.map((x) => ({ id: x.key, type: x.type, title: x.title })),
      );
      const col = cols.find((x) => x.key === key);
      if (col) {
        const roots = [...new Set(entries.map((e) => e.item.rootItemId ?? e.item.id))];
        // S-28: through the calculator, as the viewer sees the cell — a relation's stored text names every linked
        // item, also those on boards / rows the viewer may not see.
        const def = columnTypes.get(col.type);
        if (def) {
          const calc = await calculatorFor(c.db, c.a, roots);
          cellText = new Map(roots.map((id) => [id, calc.display(id, col, def)?.text ?? '']));
        }
      }
    }
    for (const e of entries) {
      if (e.running) running++;
      let key: string;
      let label: string;
      switch (s.group_by) {
        case 'board':
          [key, label] = [b.id, b.name];
          break;
        case 'item':
          [key, label] = [e.item.id, e.item.name];
          break;
        case 'day':
          [key, label] = [e.day, e.day];
          break;
        case 'column': {
          const text = cellText.get(e.item.rootItemId ?? e.item.id)?.trim() ?? '';
          [key, label] = [text ? text.toLocaleLowerCase() : EMPTY_BUCKET, text];
          break;
        }
        default:
          [key, label] = [e.entry.userId ?? '', e.who];
      }
      const g = groups.get(key) ?? { key, label, duration_s: 0, billable_s: 0, entries: 0 };
      g.duration_s += e.seconds;
      if (e.entry.billable) g.billable_s += e.seconds;
      g.entries++;
      groups.set(key, g);
    }
  }
  const rows = [...groups.values()].sort((x, y) =>
    s.group_by === 'day' ? x.key.localeCompare(y.key) : y.duration_s - x.duration_s,
  );
  return {
    data: {
      from: range.from ?? null,
      to: range.to ?? null,
      total_s: rows.reduce((n, r) => n + r.duration_s, 0),
      billable_s: rows.reduce((n, r) => n + r.billable_s, 0),
      running,
      rows,
    },
    truncated: false,
  };
};

/** The data of an embedded board view: the view's query (and the filter bar), its first visible columns. */
const boardView = async (c: Ctx, settings: Record<string, unknown>, boardName: string | null) => {
  const s = settings as { board_id: string | null; view_id: string | null; limit: number };
  if (!s.board_id || !boardName) return { data: null, truncated: false };
  const view = s.view_id ? await findView(c.db, c.a.ctx.accountId, s.view_id) : undefined;
  const usable =
    view && view.boardId === s.board_id && (view.visibility === 'shared' || view.createdBy === c.a.user.id)
      ? view
      : undefined;
  const vs = viewSettingsSchema.catch(viewSettingsSchema.parse({})).parse(usable?.settings ?? {});
  const access = await loadBoardAccess(c.db, c.a.ctx, c.a.user, s.board_id);
  const columns = (await visibleColumns(c.db, access)).filter((col) => !vs.hidden_columns.includes(col.key));
  const at = new Map(vs.column_order.map((k, i) => [k, i]));
  const ordered = [...columns]
    .sort((p, q) => (at.get(p.key) ?? 1e6) - (at.get(q.key) ?? 1e6))
    .filter((col) => columnTypes.get(col.type)?.storage !== 'item')
    .slice(0, 8);
  const query = querySchema.parse({
    ...vs.query,
    ...(c.bar.search?.trim() ? { search: c.bar.search.trim() } : {}),
    ...(c.bar.person ? { person: c.bar.person } : {}),
    scope: 'parents',
    ignore_invalid_rules: true,
  });
  const res = await queryItems(c.db, c.a, s.board_id, query, { limit: s.limit });
  const env: QueryEnv = {
    columns: columns.map((col) => ({ id: col.key, type: col.type, settings: col.settings as Record<string, unknown> })),
    meId: c.a.user.id,
    today: c.env.today,
    timezone: c.env.timezone,
    weekend: c.env.weekend,
    firstDay: c.env.firstDay,
    calendar: c.env.calendar,
  };
  const fields = ordered.map((col) => resolveField(col.key, env));
  const b: BoardRows = {
    board: { id: s.board_id, name: boardName },
    top: { id: s.board_id, name: boardName },
    parents: new Map(),
    columns,
    refColumns: [],
    rows: res.data as QueryRow[],
    groups: new Map(),
    truncated: false,
    queryEnv: env,
  };
  return {
    data: {
      board: { id: s.board_id, name: boardName },
      view: usable ? { id: usable.id, name: usable.name } : null,
      columns: ordered.map((col) => ({ title: col.title, type: col.type })),
      rows: tableRows(b, fields, s.limit),
      total: res.total,
    },
    truncated: false,
  };
};

const HANDLERS: Record<string, Handler> = {
  numbers,
  battery,
  chart,
  table,
  calendar: dated,
  timeline: dated,
  workload,
  time_report: timeReport,
};

// --- drill-down: the items behind a value clicked in a widget ----

/** Which of a widget's rows fall under the clicked value — the same buckets its data counted them in. */
type Drill = (
  c: Ctx,
  settings: Record<string, unknown>,
  all: BoardRows[],
  pick: WidgetPick,
) => Promise<(b: BoardRows, row: QueryRow) => boolean>;

/** A row's keys in a label column (status / dropdown), as the battery and the workload split merge them. */
const labelKeys = (f: Field | null, row: QueryRow) => {
  if (!f) return [EMPTY_BUCKET];
  const keys = readIds(row, f)
    .map((id) => labelOf(f, id)?.label.trim().toLocaleLowerCase())
    .filter((k): k is string => !!k);
  return keys.length ? keys : [EMPTY_BUCKET];
};

/** `fieldOf` once per board (a drill asks for every row). */
const fieldFor = (ref: ColumnRef | null | undefined) => {
  const perBoard = new Map<BoardRows, Field | null>();
  return (b: BoardRows) => {
    if (!perBoard.has(b)) perBoard.set(b, fieldOf(b, ref));
    return perBoard.get(b)!;
  };
};

/** Counts every row; another measure only the rows with a number (what the widget's value is made of). */
const counter = (m: Measure) => {
  const perBoard = new Map<BoardRows, ((row: QueryRow) => number | null) | null>();
  return (b: BoardRows, row: QueryRow) => {
    if (!perBoard.has(b)) perBoard.set(b, measureOf(b, m));
    const read = perBoard.get(b);
    return !!read && read(row) !== null;
  };
};

const DRILLS: Record<string, Drill> = {
  numbers: async (_c, settings) => {
    return counter((settings as { measure: Measure }).measure);
  },
  battery: async (_c, settings, _all, pick) => {
    const field = fieldFor((settings as { column: ColumnRef | null }).column);
    return (b, row) => pick.segment === undefined || labelKeys(field(b), row).includes(pick.segment);
  },
  chart: async (c, settings, all, pick) => {
    const s = settings as { chart_type: string; x: Dimension; series: Dimension | null; measure: Measure };
    const xOf = await bucketer(c.db, c.a, c.env, all, s.x);
    const series = s.chart_type === 'stacked_bar' ? s.series : null;
    const sOf = series && pick.series !== undefined ? await bucketer(c.db, c.a, c.env, all, series) : null;
    const shown = new Set(pick.not_x ?? []);
    const counted = counter(s.measure);
    return (b, row) => {
      if (!counted(b, row)) return false;
      const xs = xOf(b.board.id, row.id).map((x) => x.key);
      if (pick.x !== undefined && !xs.includes(pick.x)) return false;
      // "Other": a bucket that is none of the shown ones.
      if (pick.not_x && !xs.some((k) => !shown.has(k))) return false;
      return !sOf || sOf(b.board.id, row.id).some((x) => x.key === pick.series);
    };
  },
  workload: async (_c, settings, _all, pick) => {
    const s = settings as { people_column: ColumnRef | null; measure: Measure; split_column: ColumnRef | null };
    const counted = counter(s.measure);
    const people = fieldFor(s.people_column);
    const split = fieldFor(s.split_column);
    return (b, row) => {
      const pf = people(b);
      if (!pf || !counted(b, row)) return false;
      if (pick.person !== undefined) {
        const ids = readIds(row, pf);
        if (!(ids.length ? ids : [EMPTY_BUCKET]).includes(pick.person)) return false;
      }
      if (pick.series === undefined || pick.series === 'value') return true;
      return labelKeys(split(b), row).includes(pick.series);
    };
  },
};

/** The rows a drill picks, a page of them as items to open (each over its source board). */
const drillItems = async (
  c: Ctx,
  type: string,
  settings: Record<string, unknown>,
  input: { pick: WidgetPick; cursor?: string; limit?: number },
): Promise<WidgetItems> => {
  const drill = DRILLS[type];
  if (!drill || (settings as { drill?: boolean }).drill === false)
    throw new AppError('validation_failed', 'This widget does not list its items', { type });
  const { all } = await collect(c, settings as { filter?: WidgetFilter; source?: WidgetSource });
  const keep = await drill(c, settings, all, input.pick);
  const picked = all.flatMap((b) => b.rows.filter((r) => keep(b, r)).map((r) => ({ b, r })));
  const offset = Math.max(0, Number(input.cursor) || 0);
  const limit = input.limit ?? WIDGET_ITEMS_PAGE;
  return {
    data: picked.slice(offset, offset + limit).map(({ b, r }) => ({
      id: r.id,
      board_id: b.top.id,
      board_name: b.top.name,
      name: r.name,
      parent_name: b.parents.get(r.id) ?? null,
    })),
    total: picked.length,
    next_cursor: offset + limit < picked.length ? String(offset + limit) : null,
  };
};

/** POST /dashboards/:id/widgets/:wid/data — the widget's data as this viewer may see it. */
export const widgetData = async (
  db: Db,
  a: Actor,
  dashboardId: string,
  widgetId: string,
  input: { filter?: DashboardFilter },
) => {
  const access = await loadDashboardAccess(db, a.ctx, a.user, dashboardId);
  assertDashboard(access, 'dashboard.read');
  const w: WidgetRow | undefined = await findWidget(db, a.ctx.accountId, widgetId);
  if (!w || w.dashboardId !== dashboardId) throw new AppError('not_found', 'Widget not found');
  const def = widgetTypes.get(w.type);
  if (!def) throw new AppError('not_found', 'Widget not found');
  const settings = readWidgetSettings(w.type, w.settings);
  const dash = dashboardSettingsOf(access.dashboard);
  const bar = input.filter ?? dash.filter;
  const env = await loadEnv(db, a);
  const base = { widget_id: w.id, type: w.type };
  if (!def.readsBoards) return { ...base, boards: [], hidden_boards: 0, truncated: false, data: null };
  if (w.type === 'board_view') {
    const id = typeof settings.board_id === 'string' ? settings.board_id : null;
    const src = await sourceBoards(db, a, id ? [id] : []);
    const name = src.boards[0]?.name ?? null;
    const r = await boardView({ db, a, env, boards: src.boards, bar }, settings, name);
    return {
      ...base,
      boards: src.boards.map(({ id: bid, name: n }) => ({ id: bid, name: n })),
      hidden_boards: src.hidden,
      ...r,
    };
  }
  const ids = widgetBoardIds(dash.board_ids, settings as { board_ids?: string[] });
  const src = await sourceBoards(db, a, ids);
  const boards = src.boards.map((b) => ({ id: b.id, name: b.name }));
  const handler = HANDLERS[w.type];
  if (!handler) throw new AppError('not_found', 'Widget not found');
  const r = await handler({ db, a, env, boards, bar }, settings);
  return { ...base, boards, hidden_boards: src.hidden, ...r };
};

/** POST /dashboards/:id/widgets/:wid/items — the items behind a clicked value, as this viewer sees them. */
export const widgetItems = async (
  db: Db,
  a: Actor,
  dashboardId: string,
  widgetId: string,
  input: { filter?: DashboardFilter; pick: WidgetPick; cursor?: string; limit?: number },
): Promise<WidgetItems> => {
  const access = await loadDashboardAccess(db, a.ctx, a.user, dashboardId);
  assertDashboard(access, 'dashboard.read');
  const w: WidgetRow | undefined = await findWidget(db, a.ctx.accountId, widgetId);
  if (!w || w.dashboardId !== dashboardId || !widgetTypes.get(w.type))
    throw new AppError('not_found', 'Widget not found');
  const settings = readWidgetSettings(w.type, w.settings);
  const dash = dashboardSettingsOf(access.dashboard);
  const ids = widgetBoardIds(dash.board_ids, settings as { board_ids?: string[] });
  const src = await sourceBoards(db, a, ids);
  const boards = src.boards.map((b) => ({ id: b.id, name: b.name }));
  const env = await loadEnv(db, a);
  return drillItems({ db, a, env, boards, bar: input.filter ?? dash.filter }, w.type, settings, input);
};

/**
 * POST /boards/:id/widget-data (round 15) — one widget of the board's Dashboard view, with the same handlers as a
 * dashboard's over this one board (its items and / or subitems), narrowed by the view's filter, search and person
 * when the view sends them. Reading the board is enough: every row is still the viewer's own (access, `view_items`,
 * column restrictions of the board and of its sub-board).
 */
export const boardWidgetData = async (
  db: Db,
  a: Actor,
  boardId: string,
  input: { widget: { type: string; settings: Record<string, unknown> }; query?: Query },
) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
  const type = input.widget.type;
  const def = widgetTypes.get(type);
  if (!def) throw new AppError('validation_failed', 'Unknown widget type', { type });
  const settings = parseWidgetSettings(type, input.widget.settings);
  const boards = [{ id: access.board.id, name: access.board.name }];
  const base = { type, boards, hidden_boards: 0 };
  if (!def.readsBoards) return { ...base, truncated: false, data: null };
  const handler = HANDLERS[type];
  if (!handler) throw new AppError('validation_failed', 'Unknown widget type', { type });
  const q = input.query;
  const filter = q?.filter?.rules.length ? q.filter : undefined;
  const search = q?.search?.trim();
  const bar: DashboardFilter = { ...(search ? { search } : {}), ...(q?.person ? { person: q.person } : {}) };
  const env = await loadEnv(db, a);
  const r = await handler(
    { db, a, env, boards, bar, view: { filter, narrows: !!(filter || search || q?.person) } },
    { ...settings, board_ids: [] },
  );
  return { ...base, ...r };
};

/** POST /boards/:id/widget-items — the drill-down of a board Dashboard view's widget. */
export const boardWidgetItems = async (
  db: Db,
  a: Actor,
  boardId: string,
  input: {
    widget: { type: string; settings: Record<string, unknown> };
    query?: Query;
    pick: WidgetPick;
    cursor?: string;
    limit?: number;
  },
): Promise<WidgetItems> => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
  const type = input.widget.type;
  if (!widgetTypes.get(type)) throw new AppError('validation_failed', 'Unknown widget type', { type });
  const settings = parseWidgetSettings(type, input.widget.settings);
  const q = input.query;
  const filter = q?.filter?.rules.length ? q.filter : undefined;
  const search = q?.search?.trim();
  const bar: DashboardFilter = { ...(search ? { search } : {}), ...(q?.person ? { person: q.person } : {}) };
  const env = await loadEnv(db, a);
  return drillItems(
    {
      db,
      a,
      env,
      boards: [{ id: access.board.id, name: access.board.name }],
      bar,
      view: { filter, narrows: !!(filter || search || q?.person) },
    },
    type,
    { ...settings, board_ids: [] },
    input,
  );
};
