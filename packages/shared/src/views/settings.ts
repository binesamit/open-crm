// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { MAX_SORT_LEVELS, querySchema, sortLevelSchema } from '../query/filter';
import { coloringRuleSchema, MAX_COLORING_RULES } from '../query/coloring';
import { SUMMARY_FNS } from '../query/summary';
import { ZOOMS } from '../timeline/axis';
import { WORKLOAD_MEASURES, WORKLOAD_SOURCES, WORKLOAD_UNITS } from '../timeline/workload';
import { viewChartSchema } from './chart';
import { viewDashboardSchema } from './dashboard';

/**
 * View settings (15-VIEWS §7): what a view saves — the query (13-FILTERS) plus layout. The UI always shows
 * `effective = merge(view.settings, personal prefs, draft)` (15 §1).
 */
/** Extra boards an extension view may use at most (`settings.extension.board_ids`). */
export const EXT_VIEW_MAX_BOARDS = 20;

export const VIEW_TYPES = [
  'table',
  'kanban',
  'calendar',
  'cards',
  'timeline',
  'gantt',
  'workload',
  'chart',
  'files',
  'map',
  /** A board view of an installed extension (D27, ת2): `settings.extension` names it. */
  'extension',
  /** A public form on the board (M11): its questions and settings live in `forms` (GET /views/:id/form). */
  'form',
  /** Round 15: dashboard widgets scoped to the board (`settings.dashboard`). */
  'dashboard',
] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

/** What a file is, for the Files view's filter (by MIME type and extension — `fileKindOf`). */
export const FILE_KINDS = [
  'image',
  'pdf',
  'video',
  'audio',
  'document',
  'spreadsheet',
  'presentation',
  'other',
] as const;
export type FileKind = (typeof FILE_KINDS)[number];
const EXT: Record<string, FileKind> = {
  pdf: 'pdf',
  doc: 'document',
  docx: 'document',
  odt: 'document',
  rtf: 'document',
  txt: 'document',
  md: 'document',
  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  ods: 'spreadsheet',
  csv: 'spreadsheet',
  ppt: 'presentation',
  pptx: 'presentation',
  odp: 'presentation',
};
export const fileKindOf = (f: { name: string; mime: string }): FileKind => {
  const m = f.mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? '';
  if (EXT[ext]) return EXT[ext];
  if (m.includes('spreadsheet') || m.includes('ms-excel')) return 'spreadsheet';
  if (m.includes('presentation') || m.includes('powerpoint')) return 'presentation';
  if (m.includes('word') || m.startsWith('text/')) return 'document';
  return 'other';
};

const widthSchema = z.number().int().min(60).max(800);

/** System row groupings of a timeline / Gantt (else a people / status / dropdown column id). */
export const TIMELINE_GROUP = '__group__';
export const TIMELINE_NO_GROUP = '__none__';

/** Timeline (M8 ד6): bars by a date / timeline column, rows grouped, coloured, at a zoom. */
const timelineViewSchema = z.object({
  date_column_id: z.string().max(64).optional(),
  /** `__group__` (default) = board groups, `__none__` = one list, or a people / status / dropdown column. */
  group_by: z.string().max(64).optional(),
  /** A status / dropdown column; unset = the group's colour. */
  color_by: z.string().max(64).optional(),
  zoom: z.enum(ZOOMS).default('week'),
  /** the axis leaves out days that count 0 in working days (weekends, days off); half days stay. */
  working_days_only: z.boolean().optional(),
});
/** Gantt (M8 ד7): a timeline with the item tree, subitems and dependency arrows. */
const ganttViewSchema = timelineViewSchema.extend({
  /** The dependency column drawn as arrows; unset = the board's first one. */
  dependency_column_id: z.string().max(64).optional(),
  show_subitems: z.boolean().default(true),
  show_critical: z.boolean().default(false),
});
/** Workload (M8 ד8): load per person per day / week against a capacity. */
const workloadViewSchema = z.object({
  people_column_id: z.string().max(64).optional(),
  date_column_id: z.string().max(64).optional(),
  measure: z.enum(WORKLOAD_MEASURES).default('count'),
  /** numbers / time-estimate column for `measure: 'column'`. */
  effort_column_id: z.string().max(64).optional(),
  unit: z.enum(WORKLOAD_UNITS).default('day'),
  /** Daily capacity; unset = `defaultCapacity(measure)`. */
  capacity: z.number().min(0).max(10000).optional(),
  /** Per person (user / team id) daily capacity. */
  capacity_overrides: z.record(z.string().max(64), z.number().min(0).max(10000)).default({}),
  /**
   * Round 15: whose people / dates / effort count — the items, their subitems (the sub-board's own columns, below),
   * or both. A subitem counts while its parent item is in the view.
   */
  source: z.enum(WORKLOAD_SOURCES).default('items'),
  /** The sub-board's people / date / effort columns (unset = the first that fits). */
  sub_people_column_id: z.string().max(64).optional(),
  sub_date_column_id: z.string().max(64).optional(),
  sub_effort_column_id: z.string().max(64).optional(),
});

/** what a click on an empty spot of a calendar day offers. */
export const CALENDAR_EMPTY_CLICK = ['both', 'new', 'existing', 'off'] as const;
export type CalendarEmptyClick = (typeof CALENDAR_EMPTY_CLICK)[number];
/** the calendar's ranges; day / 3 days / week / work week show hours when the view turns them on. */
export const CALENDAR_MODES = ['month', 'week', 'workweek', '3day', 'day'] as const;
export type CalendarMode = (typeof CALENDAR_MODES)[number];
export const CALENDAR_TIME_SOURCES = ['timeline', 'date_hours'] as const;
export type CalendarTimeSource = (typeof CALENDAR_TIME_SOURCES)[number];
export const CALENDAR_HOUR_HEIGHTS = ['small', 'normal', 'large'] as const;

export const calendarViewSchema = z.object({
  date_column_id: z.string().max(64).optional(),
  color_by: z.string().max(64).optional(),
  default: z.enum(CALENDAR_MODES).default('month'),
  /**
   * day / week by the hour. Off = days only (as before). The hours come from a timeline "with
   * hours" (`date_column_id` is that timeline) or from a date plus two hour columns; without an end column an
   * item lasts `default_duration`.
   */
  show_hours: z.boolean().default(false),
  time_source: z.enum(CALENDAR_TIME_SOURCES).default('timeline'),
  start_hour_column_id: z.string().max(64).optional(),
  end_hour_column_id: z.string().max(64).optional(),
  /** Minutes a drag snaps to. */
  snap: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30)]).default(15),
  /** The hours shown (the grid scrolls over the rest of the day): from 0–23, to 1–24. */
  day_start: z.number().int().min(0).max(23).default(7),
  day_end: z.number().int().min(1).max(24).default(21),
  hour_height: z.enum(CALENDAR_HOUR_HEIGHTS).default('normal'),
  /** Minutes: a new item from a click, and an item with a start and no end. */
  default_duration: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(60),
  show_weekends: z.boolean().default(true),
  /** The fields the quick card shows (column ids); empty = the first few. */
  card_fields: z.array(z.string().max(64)).max(20).default([]),
  /**
   * a click on an empty spot of a day (or a drag across days) — a new item on that day, a date for
   * an existing item, both (default), or nothing. Written to the view's date / timeline column.
   */
  empty_click: z.enum(CALENDAR_EMPTY_CLICK).default('both'),
});
export type CalendarViewSettings = z.infer<typeof calendarViewSchema>;
/** A view's calendar settings with every default filled in (a view saved before a setting existed has none). */
export const calendarSettingsOf = (c?: Partial<CalendarViewSettings> | null): CalendarViewSettings =>
  calendarViewSchema.parse(c ?? {});

export const viewSettingsSchema = z.object({
  query: querySchema.default(querySchema.parse({})),
  hidden_columns: z.array(z.string().max(64)).max(500).default([]),
  /** The view's column order (keys); columns not listed follow in board order. Empty = the board's order. */
  column_order: z.array(z.string().max(64)).max(500).default([]),
  column_widths: z.record(z.string().max(64), widthSchema).default({}),
  collapsed_groups: z.array(z.string().max(64)).max(500).default([]),
  wrap_text: z.boolean().default(false),
  row_height: z.enum(['single', 'double', 'triple']).default('single'),
  /** Round 12: the table view on a phone — a real table (sticky name, columns scroll sideways) or cards. */
  mobile_layout: z.enum(['table', 'cards']).default('table'),
  show_summary: z.boolean().default(true),
  /** Footer calculation per column (`summaryOptions`); a column left out shows its type's default. */
  summaries: z.record(z.string().max(64), z.enum(SUMMARY_FNS)).default({}),
  /**
   * N3: one field summarised next to each group's name (like the footer, its own function); off = null.
   * `fn` missing = the same calculation the footer shows for that column.
   */
  group_summary: z
    .object({ column_id: z.string().max(64), fn: z.enum(SUMMARY_FNS).optional() })
    .nullable()
    .default(null),
  /**
   * Owner fix: the order of the subitems under each item (the table), by the sub-board's columns — levels like
   * `query.sort`. Empty = their manual (dragged) order.
   */
  subitems_sort: z.array(sortLevelSchema).max(MAX_SORT_LEVELS).default([]),
  /**
   * Round 13: the sub-board's columns this view hides under each item (ids of the sub-board's columns) —
   * the toolbar's "hide" panel, saved like `hidden_columns`.
   */
  subitems_hidden_columns: z.array(z.string().max(64)).max(500).default([]),
  kanban: z
    .object({
      column_id: z.string().max(64).optional(),
      card_fields: z.array(z.string().max(64)).max(50).default([]),
      show_empty: z.boolean().default(true),
      /** Lane order of this view (label ids, `__empty__` for blank); unknown lanes follow in label order. */
      lane_order: z.array(z.string().max(64)).max(1000).default([]),
    })
    .optional(),
  calendar: calendarViewSchema.optional(),
  cards: z.object({ fields: z.array(z.string().max(64)).max(50).default([]) }).optional(),
  timeline: timelineViewSchema.optional(),
  gantt: ganttViewSchema.optional(),
  workload: workloadViewSchema.optional(),
  /** Chart view (M8 ד9): type, axis, series and measure — the dashboard chart widget on this board. */
  chart: viewChartSchema.optional(),
  /** Dashboard view (round 15): its widgets and whether the view's toolbar narrows them. */
  dashboard: viewDashboardSchema.optional(),
  /** Files view (M8 ד9): which files show (empty lists = all) and their order. */
  files: z
    .object({
      columns: z.array(z.string().max(64)).max(100).default([]),
      kinds: z.array(z.enum(FILE_KINDS)).max(FILE_KINDS.length).default([]),
      uploaders: z.array(z.string().max(64)).max(200).default([]),
      include_updates: z.boolean().default(true),
      sort: z.enum(['newest', 'oldest', 'name', 'size']).default('newest'),
    })
    .optional(),
  /** Map view (M8 ד10): the location column, what colours the markers, the fields on the card. */
  map: z
    .object({
      location_column_id: z.string().max(64).optional(),
      color_by: z.string().max(64).optional(),
      card_fields: z.array(z.string().max(64)).max(50).default([]),
    })
    .optional(),
  /**
   * Extension view (D27, ת2): which installation and which of its board-view features this tab shows.
   * `board_ids`: more boards the view's token may use besides this one (e.g. a workout view that
   * writes to a log board), picked by a person in the app's own dialog (never by the extension). The server keeps only
   * those the viewer may read and the installation is allowed on (like an extension widget's boards, ת5).
   */
  extension: z
    .object({
      installation_id: z.string().max(26),
      feature: z.string().max(40),
      board_ids: z.array(z.string().max(26)).max(EXT_VIEW_MAX_BOARDS).optional(),
    })
    .optional(),
  /** Conditional coloring: rules colouring whole items or cells; first match wins. */
  coloring: z.array(coloringRuleSchema).max(MAX_COLORING_RULES).default([]),
});
export type ViewSettings = z.infer<typeof viewSettingsSchema>;
export type ViewSettingsInput = z.input<typeof viewSettingsSchema>;

/** Columns in a view's order (`column_order`); the ones it doesn't list keep the board order, after them. */
export const orderColumns = <C extends { id: string }>(columns: C[], order: string[]): C[] => {
  if (!order.length) return columns;
  const at = new Map(order.map((id, i) => [id, i]));
  const listed = columns.filter((c) => at.has(c.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  return [...listed, ...columns.filter((c) => !at.has(c.id))];
};

/** Personal overrides (15 §1): never shared, saved automatically, never bump the view's revision. */
export const viewPrefsSchema = z.object({
  column_widths: z.record(z.string().max(64), widthSchema).optional(),
  collapsed_groups: z.array(z.string().max(64)).max(500).optional(),
  wrap_text: z.boolean().optional(),
  /** my own column order on the default table, used when the board's order there is `personal`. */
  column_order: z.array(z.string().max(64)).max(500).optional(),
});
export type ViewPrefs = z.infer<typeof viewPrefsSchema>;

export const defaultViewSettings = (): ViewSettings => viewSettingsSchema.parse({});

/** Stable JSON (sorted keys) of normalised settings, for "is the draft different from the view?" (15 §2). */
const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
            .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
        )
      : v;

const diffKeys = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => JSON.stringify(stable(a[k])) !== JSON.stringify(stable(b[k])),
  );

/**
 * What differs between two settings, after normalisation (the "3 changes" counter of 15 §2): top-level keys,
 * with the query split into its parts (`query.filter`, `query.sort`, …).
 */
export const changedSettings = (a: ViewSettingsInput, b: ViewSettingsInput): string[] => {
  const na = viewSettingsSchema.parse(a);
  const nb = viewSettingsSchema.parse(b);
  const { query: qa, ...ra } = na;
  const { query: qb, ...rb } = nb;
  return [...diffKeys(qa, qb).map((k) => `query.${k}`), ...diffKeys(ra, rb)];
};

/**
 * My tab layout on a board (personal, `user_board_prefs.settings.layout`): pinned views first, in my order;
 * the others after them in my order. Views I never arranged follow by their shared position.
 */
export const viewLayoutSchema = z.object({
  pinned: z.array(z.string().max(64)).max(500).default([]),
  order: z.array(z.string().max(64)).max(1000).default([]),
});
export type ViewLayout = z.infer<typeof viewLayoutSchema>;

export const arrangeViews = <V extends { id: string; position: string }>(
  views: V[],
  layout: ViewLayout,
): (V & { pinned: boolean })[] => {
  const rank = (id: string) => {
    const i = layout.order.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = [...views].sort(
    (a, b) => rank(a.id) - rank(b.id) || (a.position < b.position ? -1 : a.position > b.position ? 1 : 0),
  );
  const pinned = new Set(layout.pinned);
  return [
    ...sorted.filter((v) => pinned.has(v.id)).map((v) => ({ ...v, pinned: true })),
    ...sorted.filter((v) => !pinned.has(v.id)).map((v) => ({ ...v, pinned: false })),
  ];
};

/**
 * A view's settings for another board (copy a view, 15 §9): every column reference goes through `mapColumn`
 * (source key → the target's key, or null = no such column). Unmapped rules, sort levels, grouping and fields are
 * dropped; system fields (`__group__`…) are kept. Lane order and summaries follow their column.
 */
export const remapViewSettings = (s: ViewSettings, mapColumn: (key: string) => string | null): ViewSettings => {
  const map = (key: string) => (key.startsWith('__') ? key : mapColumn(key));
  type Node = NonNullable<ViewSettings['query']['filter']>;
  const remapGroup = (g: Node): Node | null => {
    const rules = g.rules.flatMap((r): Node['rules'] => {
      if ('kind' in r && r.kind === 'group') {
        const sub = remapGroup(r as Node);
        return sub ? [sub] : [];
      }
      const rule = r as Extract<Node['rules'][number], { column_id: string }>;
      const id = map(rule.column_id);
      return id ? [{ ...rule, column_id: id }] : [];
    });
    return rules.length ? { ...g, rules } : null;
  };
  const keys = (list: string[]) => list.flatMap((k) => (map(k) ? [map(k)!] : []));
  const record = <V>(r: Record<string, V>) =>
    Object.fromEntries(Object.entries(r).flatMap(([k, v]) => (map(k) ? [[map(k)!, v]] : [])));
  const q = s.query;
  const groupBy = q.group_by && map(q.group_by.column_id);
  const filter = q.filter ? remapGroup(q.filter) : null;
  const kanbanColumn = s.kanban?.column_id ? map(s.kanban.column_id) : undefined;
  return {
    ...s,
    query: {
      ...q,
      filter: filter ?? undefined,
      sort: q.sort.flatMap((x) => (map(x.column_id) ? [{ ...x, column_id: map(x.column_id)! }] : [])),
      group_by: q.group_by && groupBy ? { ...q.group_by, column_id: groupBy } : undefined,
    },
    hidden_columns: keys(s.hidden_columns),
    column_order: keys(s.column_order),
    column_widths: record(s.column_widths),
    summaries: record(s.summaries),
    collapsed_groups: [],
    kanban: s.kanban && {
      ...s.kanban,
      column_id: kanbanColumn ?? undefined,
      card_fields: keys(s.kanban.card_fields),
      // Lanes are the column's labels: they carry over only to the same column.
      lane_order: kanbanColumn && kanbanColumn === s.kanban.column_id ? s.kanban.lane_order : [],
    },
    calendar: s.calendar && {
      ...s.calendar,
      date_column_id: s.calendar.date_column_id ? (map(s.calendar.date_column_id) ?? undefined) : undefined,
      color_by: s.calendar.color_by ? (map(s.calendar.color_by) ?? undefined) : undefined,
      start_hour_column_id: s.calendar.start_hour_column_id
        ? (map(s.calendar.start_hour_column_id) ?? undefined)
        : undefined,
      end_hour_column_id: s.calendar.end_hour_column_id ? (map(s.calendar.end_hour_column_id) ?? undefined) : undefined,
      card_fields: keys(s.calendar.card_fields ?? []),
    },
    cards: s.cards && { fields: keys(s.cards.fields) },
    timeline: s.timeline && remapTimeline(s.timeline, map),
    gantt: s.gantt && {
      ...remapTimeline(s.gantt, map),
      dependency_column_id: s.gantt.dependency_column_id ? (map(s.gantt.dependency_column_id) ?? undefined) : undefined,
    },
    workload: s.workload && {
      ...s.workload,
      people_column_id: s.workload.people_column_id ? (map(s.workload.people_column_id) ?? undefined) : undefined,
      date_column_id: s.workload.date_column_id ? (map(s.workload.date_column_id) ?? undefined) : undefined,
      effort_column_id: s.workload.effort_column_id ? (map(s.workload.effort_column_id) ?? undefined) : undefined,
      // The sub-board's columns are another board's: the copy picks its own (the first that fits).
      sub_people_column_id: undefined,
      sub_date_column_id: undefined,
      sub_effort_column_id: undefined,
    },
    chart: s.chart && {
      ...s.chart,
      x:
        s.chart.x.kind === 'column' && !map(s.chart.x.column_id)
          ? { kind: 'group' }
          : s.chart.x.kind === 'column'
            ? { ...s.chart.x, column_id: map(s.chart.x.column_id)! }
            : s.chart.x,
      series:
        s.chart.series?.kind === 'column'
          ? map(s.chart.series.column_id)
            ? { ...s.chart.series, column_id: map(s.chart.series.column_id)! }
            : null
          : s.chart.series,
      measure: s.chart.measure.column_id
        ? map(s.chart.measure.column_id)
          ? { ...s.chart.measure, column_id: map(s.chart.measure.column_id)! }
          : { fn: 'count', column_id: null }
        : s.chart.measure,
    },
    files: s.files && { ...s.files, columns: keys(s.files.columns) },
    map: s.map && {
      location_column_id: s.map.location_column_id ? (map(s.map.location_column_id) ?? undefined) : undefined,
      color_by: s.map.color_by ? (map(s.map.color_by) ?? undefined) : undefined,
      card_fields: keys(s.map.card_fields),
    },
    coloring: s.coloring.flatMap((c) => {
      const id = map(c.rule.column_id);
      const target = c.column_id ? map(c.column_id) : undefined;
      return id && (!c.column_id || target)
        ? [{ ...c, rule: { ...c.rule, column_id: id }, column_id: target ?? undefined }]
        : [];
    }),
  };
};

/** A timeline's column references on another board (system groupings are kept). */
const remapTimeline = <T extends NonNullable<ViewSettings['timeline']>>(
  t: T,
  map: (key: string) => string | null,
): T => ({
  ...t,
  date_column_id: t.date_column_id ? (map(t.date_column_id) ?? undefined) : undefined,
  group_by: t.group_by ? (map(t.group_by) ?? undefined) : undefined,
  color_by: t.color_by ? (map(t.color_by) ?? undefined) : undefined,
});
