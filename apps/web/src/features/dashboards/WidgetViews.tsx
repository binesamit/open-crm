// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  formatDate,
  formatDuration,
  formatNumber,
  paint,
  t,
  todayIn,
  type MyAccount,
  type Widget,
  type WidgetData,
  type WidgetPick,
} from '@bines/shared';
import { cn } from '@bines/ui';
import { tagVars } from '../../lib/label-color';
import { numbersAffixes } from './numbers-affix';

/**
 * How each widget type draws its data (M8 ד4–ד5) — a map keyed by type, the web half of the widget registry.
 * Charts follow the dataviz method: thin marks with rounded data-ends, a 2px surface gap between segments,
 * recessive grid, a legend for 2+ series, a tooltip on every mark, text in text colours (never the series colour),
 * and the validated palette in a fixed order (`viz.css`).
 */
const EMPTY = '__empty__';
const OTHER = '__other__';

export type ViewProps<D = unknown> = {
  account: MyAccount;
  widget: Widget;
  data: WidgetData<D>;
  /** a click on a value lists the items behind it (only when the widget's drill-down is on). */
  onDrill?: (pick: WidgetPick, label: string) => void;
  /** an item opens its card here (over the dashboard), never leaving the page. */
  openItem?: (boardId: string, itemId: string) => void;
};

/** An item link: opens the card in place; Ctrl / Cmd / Shift click keep the link's own new tab. */
const opener =
  (openItem: ViewProps['openItem'], boardId: string, itemId: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (!openItem || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    openItem(boardId, itemId);
  };

/** A value that lists its items on click (keyboard too); nothing when the widget does not drill. */
const drillProps = (onDrill: ViewProps['onDrill'], pick: WidgetPick, label: string) =>
  onDrill
    ? {
        role: 'button' as const,
        tabIndex: 0,
        'data-drill': '',
        'aria-label': t('dashboards.drill.show', { label }),
        onClick: () => onDrill(pick, label),
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onDrill(pick, label);
        },
      }
    : {};

/** A series colour: the label's own (status / dropdown), else the palette slot in a fixed order. */
const slot = (i: number) => (i < 8 ? `var(--viz-${i + 1})` : 'var(--viz-other)');
const bucketLabel = (b: { key: string; label: string }) =>
  b.key === EMPTY ? t('dashboards.none') : b.key === OTHER ? t('dashboards.other') : b.label;
const isRtl = () => typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
const compact = (n: number) =>
  Math.abs(n) >= 10_000
    ? formatNumber(n, { notation: 'compact', maximumFractionDigits: 1 })
    : formatNumber(n, { maximumFractionDigits: 2 });

const Empty = ({ children }: { children?: ReactNode }) => (
  <div className="grid h-full place-items-center px-3 text-center text-sm text-muted" data-testid="widget-empty">
    {children ?? t('dashboards.noData')}
  </div>
);

// ---- numbers ----
type NumbersData = { value: number | null; text: string; items: number };
const NumbersView = ({ data, widget, onDrill }: ViewProps<NumbersData>) => {
  const s = widget.settings as { prefix?: string; suffix?: string };
  const d = data.data;
  const text = d.value === null ? '—' : /^-?\d+(\.\d+)?$/.test(d.text) ? compact(d.value) : d.text;
  // r27: the column's own unit is already in the server's text — the widget's same prefix / suffix shows once.
  const affix = numbersAffixes(d.value === null ? '' : d.text, s.prefix, s.suffix);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 text-center" data-testid="widget-numbers">
      <span
        className={cn(
          'text-[2.75rem] leading-none font-bold tracking-[-1px] text-heading tabular-nums max-md:text-4xl',
          onDrill && 'cursor-pointer rounded-[8px] px-1 hover:bg-surface-2',
        )}
        data-testid="widget-number"
        data-value={d.value ?? ''}
        {...drillProps(onDrill, {}, '')}
      >
        {affix.prefix}
        {text}
        {affix.suffix}
      </span>
      <span className="text-xs text-muted">{t('dashboards.items', { n: d.items })}</span>
    </div>
  );
};

// ---- battery ----
type BatteryData = { total: number; segments: { key: string; label: string; color: string | null; count: number }[] };
const BatteryView = ({ data, onDrill }: ViewProps<BatteryData>) => {
  const d = data.data;
  if (!d.total) return <Empty />;
  return (
    <div className="flex h-full flex-col justify-center gap-3" data-testid="widget-battery">
      <div
        className="flex h-6 w-full gap-[0.125rem] overflow-hidden rounded-[6px]"
        role="img"
        aria-label={t('dashboards.type.battery')}
      >
        {d.segments.map((s) => (
          <div
            key={s.key}
            className={cn('h-full', onDrill && 'cursor-pointer hover:opacity-80')}
            style={{ flexGrow: s.count, background: paint(s.color) ?? 'var(--status-empty)' }}
            title={`${bucketLabel(s)} · ${s.count} (${Math.round((s.count / d.total) * 100)}%)`}
            data-testid="battery-segment"
            data-label={s.label}
            data-count={s.count}
            {...drillProps(onDrill, { segment: s.key }, bucketLabel(s))}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2">
        {d.segments.map((s) => (
          <li
            key={s.key}
            className={cn('inline-flex items-center gap-1.5', onDrill && 'cursor-pointer hover:text-fg')}
            {...drillProps(onDrill, { segment: s.key }, bucketLabel(s))}
          >
            <span
              aria-hidden
              className="size-2.5 rounded-full"
              style={{ background: paint(s.color) ?? 'var(--status-empty)' }}
            />
            <span>{bucketLabel(s)}</span>
            <span className="font-normal text-fg tabular-nums">{Math.round((s.count / d.total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

// ---- chart ----
type ChartData = {
  series: { key: string; label: string; color: string | null }[];
  rows: { key: string; label: string; color: string | null; values: Record<string, number> }[];
};

const ChartTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string; payload?: { fill?: string } }[];
  label?: string;
}) =>
  active && payload?.length ? (
    <div className="rounded-[10px] border border-line bg-surface px-2.5 py-1.5 text-xs shadow-md">
      {label ? <div className="mb-1 font-semibold text-fg">{label}</div> : null}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5 text-fg-2">
          <span aria-hidden className="size-2 rounded-full" style={{ background: paint(p.color) ?? p.payload?.fill }} />
          {p.name ? <span>{p.name}</span> : null}
          <span className="ms-auto ps-3 font-normal text-fg tabular-nums">{compact(Number(p.value ?? 0))}</span>
        </div>
      ))}
    </div>
  ) : null;

const Legend = ({ items }: { items: { label: string; color: string }[] }) =>
  items.length > 1 ? (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 px-1 pt-1 text-xs text-fg-2" data-testid="chart-legend">
      {items.map((s, i) => (
        <li key={i} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: paint(s.color) }} />
          {s.label}
        </li>
      ))}
    </ul>
  ) : null;

const ChartView = ({ data, widget, onDrill }: ViewProps<ChartData>) => {
  const type = (widget.settings as { chart_type?: string }).chart_type ?? 'bar';
  const d = data.data;
  const rtl = isRtl();
  const rows = useMemo(
    () => d.rows.map((r, i) => ({ ...r, name: bucketLabel(r), fill: paint(r.color) ?? slot(i), ...r.values })),
    [d.rows],
  );
  if (!rows.length) return <Empty />;
  const series = d.series.map((s, i) => ({ ...s, name: bucketLabel(s), fill: paint(s.color) ?? slot(i) }));
  const single = series.length <= 1;
  // a bar / slice / point lists its items - "other" = every bucket not shown; a stacked part adds
  // its series.
  const shownKeys = rows.filter((r) => r.key !== OTHER).map((r) => r.key);
  const drillRow = (i: number | undefined, seriesKey?: string) => {
    const row = i === undefined ? undefined : rows[i];
    if (!onDrill || !row) return;
    const s = seriesKey && !single ? series.find((x) => x.key === seriesKey) : undefined;
    const x: WidgetPick = row.key === OTHER ? { not_x: shownKeys } : { x: row.key };
    onDrill({ ...x, ...(s ? { series: s.key } : {}) }, s ? `${row.name} · ${s.name}` : row.name);
  };
  const pointer = onDrill ? { cursor: 'pointer' } : undefined;
  // In rem: the axis text follows the person's text size like the rest of the page.
  const axis = { fontSize: '0.6875rem', fill: 'var(--viz-axis)' };
  if (type === 'pie' || type === 'donut') {
    const valueKey = series[0]?.key ?? 'value';
    return (
      <div className="viz flex h-full flex-col" data-testid="widget-chart" data-chart="pie">
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={rows}
                dataKey={valueKey}
                nameKey="name"
                innerRadius={type === 'donut' ? '55%' : 0}
                outerRadius="85%"
                stroke="var(--viz-gap)"
                strokeWidth={2}
                isAnimationActive={false}
                onClick={(_: unknown, i: number) => drillRow(i)}
                style={pointer}
              >
                {rows.map((r) => (
                  <Cell key={r.key} fill={r.fill} />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <Legend items={rows.map((r) => ({ label: r.name, color: r.fill }))} />
      </div>
    );
  }
  if (type === 'line') {
    const key = series[0]?.key ?? 'value';
    return (
      <div className="viz h-full" data-testid="widget-chart" data-chart="line">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={rows}
            margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
            onClick={(state) =>
              drillRow(state?.activeTooltipIndex == null ? undefined : Number(state.activeTooltipIndex))
            }
            style={pointer}
          >
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
            <XAxis
              dataKey="name"
              reversed={rtl}
              tick={axis}
              tickLine={false}
              axisLine={{ stroke: 'var(--viz-grid)' }}
            />
            <YAxis
              orientation={rtl ? 'right' : 'left'}
              tick={axis}
              tickLine={false}
              axisLine={false}
              width={40}
              tickFormatter={compact}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--viz-axis)', strokeWidth: 1 }} />
            <Line
              type="monotone"
              dataKey={key}
              name={series[0]?.name}
              stroke="var(--viz-1)"
              strokeWidth={2}
              dot={{ r: 4, strokeWidth: 2, stroke: 'var(--viz-gap)', fill: 'var(--viz-1)' }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }
  const stacked = type === 'stacked_bar';
  return (
    <div className="viz flex h-full flex-col" data-testid="widget-chart" data-chart={type}>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barCategoryGap="25%">
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
            <XAxis
              dataKey="name"
              reversed={rtl}
              tick={axis}
              tickLine={false}
              axisLine={{ stroke: 'var(--viz-grid)' }}
              interval={0}
            />
            <YAxis
              orientation={rtl ? 'right' : 'left'}
              tick={axis}
              tickLine={false}
              axisLine={false}
              width={40}
              tickFormatter={compact}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--surface-2)' }} />
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={single ? undefined : s.name}
                stackId={stacked ? 'a' : undefined}
                fill={s.fill}
                maxBarSize={24}
                stroke="var(--viz-gap)"
                strokeWidth={stacked ? 1 : 0}
                radius={!stacked || i === series.length - 1 ? [4, 4, 0, 0] : 0}
                isAnimationActive={false}
                onClick={(_: unknown, index: number) => drillRow(index, s.key)}
                style={pointer}
              >
                {single ? rows.map((r) => <Cell key={r.key} fill={r.fill} />) : null}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Legend items={single ? [] : series.map((s) => ({ label: s.name, color: s.fill }))} />
    </div>
  );
};

// ---- table / board view ----
type TableData = {
  columns: { title: string; type: string }[];
  rows: {
    id: string;
    board_id: string;
    board_name: string;
    name: string;
    /** A subitem's parent (round 15). */
    parent_name?: string | null;
    cells: ({ text: string; color: string | null } | null)[];
  }[];
  total: number;
  board?: { id: string; name: string };
  view?: { id: string; name: string } | null;
};
const TableView = ({ data, account, openItem }: ViewProps<TableData>) => {
  const d = data.data;
  if (!d) return <Empty>{t('dashboards.boardHidden')}</Empty>;
  if (!d.rows.length) return <Empty />;
  const many = new Set(d.rows.map((r) => r.board_id)).size > 1;
  return (
    <div className="h-full overflow-auto" data-testid="widget-table">
      {d.board ? (
        <div className="mb-1 flex items-center gap-2 text-xs text-muted">
          <Link
            to="/a/$accountSlug/b/$boardId"
            params={{ accountSlug: account.slug, boardId: d.board.id }}
            className="font-normal text-primary hover:underline"
            data-testid="widget-board-link"
          >
            {d.board.name}
          </Link>
          {d.view ? <span>· {d.view.name}</span> : null}
        </div>
      ) : null}
      <table className="w-full border-separate border-spacing-0 text-[0.8125rem]">
        <thead className="sticky top-0 z-[1] bg-surface">
          <tr className="text-start text-xs text-muted">
            <th className="border-b border-line px-2 py-1.5 text-start font-semibold">{t('dashboards.item')}</th>
            {many ? (
              <th className="border-b border-line px-2 py-1.5 text-start font-semibold">{t('dashboards.board')}</th>
            ) : null}
            {d.columns.map((c, i) => (
              <th key={i} className="border-b border-line px-2 py-1.5 text-start font-semibold">
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r) => (
            <tr key={r.id} className="hover:bg-surface-2" data-testid="widget-table-row" data-name={r.name}>
              <td className="max-w-[220px] truncate border-b border-line-soft px-2 py-1.5">
                <Link
                  to="/a/$accountSlug/b/$boardId/i/$itemId"
                  params={{ accountSlug: account.slug, boardId: r.board_id, itemId: r.id }}
                  className="text-fg hover:underline"
                  title={underParent(r)}
                  onClick={opener(openItem, r.board_id, r.id)}
                >
                  {r.parent_name ? (
                    <span className="text-muted" data-testid="widget-row-parent">
                      {r.parent_name} ›{' '}
                    </span>
                  ) : null}
                  {r.name}
                </Link>
              </td>
              {many ? (
                <td className="truncate border-b border-line-soft px-2 py-1.5 text-muted">{r.board_name}</td>
              ) : null}
              {r.cells.map((c, i) => (
                <td key={i} className="max-w-[180px] truncate border-b border-line-soft px-2 py-1">
                  {c?.color ? (
                    // The same chip as the board ("ג2"): the label's tint, its ink, regular
                    // weight — the dashboards showed the old solid white-on-colour look.
                    <span className="label-tag h-6 min-w-16 text-xs" style={tagVars(c.color)} data-color={c.color}>
                      <span className="truncate">{c.text}</span>
                    </span>
                  ) : (
                    <span className="text-fg-2">{c?.text ?? ''}</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {d.total > d.rows.length ? (
        <p className="px-2 py-1.5 text-xs text-muted">
          {t('dashboards.moreRows', { shown: d.rows.length, total: d.total })}
        </p>
      ) : null}
    </div>
  );
};

// ---- calendar ----
type DatedData = {
  items: {
    id: string;
    board_id: string;
    name: string;
    parent_name?: string | null;
    from: string;
    to: string;
    color: string | null;
    label: string | null;
  }[];
  total: number;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** A row's name in tooltips: a subitem under its parent's name (round 15). */
const underParent = (r: { name: string; parent_name?: string | null }) =>
  r.parent_name ? `${r.parent_name} › ${r.name}` : r.name;
const CalendarView = ({ data, account, openItem }: ViewProps<DatedData>) => {
  // "Today" in the account's zone, like the board calendar (audit A5) — not the UTC day.
  const [month, setMonth] = useState(() => todayIn().slice(0, 7));
  const first = new Date(`${month}-01T00:00:00Z`);
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    return iso(d);
  });
  const byDay = new Map<string, DatedData['items']>();
  for (const it of data.data.items)
    for (const day of days) if (day >= it.from && day <= it.to) byDay.set(day, [...(byDay.get(day) ?? []), it]);
  const shift = (n: number) => {
    const d = new Date(first);
    d.setUTCMonth(d.getUTCMonth() + n);
    setMonth(iso(d).slice(0, 7));
  };
  const weekday = new Intl.DateTimeFormat(document.documentElement.lang || 'he', {
    weekday: 'narrow',
    timeZone: 'UTC',
  });
  const title = new Intl.DateTimeFormat(document.documentElement.lang || 'he', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(first);
  return (
    <div className="flex h-full flex-col" data-testid="widget-calendar">
      <div className="mb-1 flex items-center gap-1">
        <button
          type="button"
          className="rounded-[8px] px-2 text-muted hover:bg-surface-2"
          onClick={() => shift(-1)}
          aria-label={t('dashboards.prevMonth')}
          title={t('dashboards.prevMonth')}
        >
          ›
        </button>
        <span className="flex-1 text-center text-sm font-semibold text-fg" data-testid="calendar-month">
          {title}
        </span>
        <button
          type="button"
          className="rounded-[8px] px-2 text-muted hover:bg-surface-2"
          onClick={() => shift(1)}
          aria-label={t('dashboards.nextMonth')}
          title={t('dashboards.nextMonth')}
        >
          ‹
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-[0.6875rem] text-muted">
        {days.slice(0, 7).map((d) => (
          <span key={d}>{weekday.format(new Date(`${d}T00:00:00Z`))}</span>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 gap-px overflow-hidden rounded-[8px] bg-line-soft">
        {days.map((day) => {
          const list = byDay.get(day) ?? [];
          return (
            <div
              key={day}
              className={cn(
                'min-h-0 overflow-hidden bg-surface p-0.5',
                day.slice(0, 7) !== month && 'bg-surface-3 text-muted',
              )}
            >
              <div className="text-[0.6875rem] leading-none text-muted">{Number(day.slice(8))}</div>
              {list.slice(0, 2).map((it) => (
                <Link
                  key={it.id}
                  to="/a/$accountSlug/b/$boardId/i/$itemId"
                  params={{ accountSlug: account.slug, boardId: it.board_id, itemId: it.id }}
                  className="mt-0.5 flex items-center gap-1 truncate rounded-[4px] bg-surface-2 px-1 text-[0.6875rem] leading-4 text-fg hover:bg-primary-soft"
                  title={`${underParent(it)}${it.label ? ` · ${it.label}` : ''}`}
                  data-testid="calendar-entry"
                  onClick={opener(openItem, it.board_id, it.id)}
                >
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: paint(it.color) ?? 'var(--viz-1)' }}
                  />
                  <span className="truncate">{it.name}</span>
                </Link>
              ))}
              {list.length > 2 ? <div className="text-[0.6875rem] text-muted">+{list.length - 2}</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ---- timeline ----
const dayNum = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
const TimelineView = ({ data, account, openItem }: ViewProps<DatedData>) => {
  const items = data.data.items.slice(0, 60);
  if (!items.length) return <Empty />;
  const min = Math.min(...items.map((i) => dayNum(i.from)));
  const max = Math.max(...items.map((i) => dayNum(i.to))) + 1;
  const span = Math.max(1, max - min);
  const today = dayNum(todayIn());
  return (
    <div className="viz h-full overflow-auto" data-testid="widget-timeline">
      <div className="mb-1 flex justify-between text-[0.6875rem] text-muted">
        <span>{formatDate(items.reduce((m, i) => (i.from < m ? i.from : m), items[0]!.from))}</span>
        <span>{formatDate(items.reduce((m, i) => (i.to > m ? i.to : m), items[0]!.to))}</span>
      </div>
      <div className="relative space-y-1">
        {today >= min && today <= max ? (
          <span
            aria-hidden
            className="absolute inset-y-0 w-px bg-accent"
            style={{ insetInlineStart: `${((today - min) / span) * 100}%` }}
          />
        ) : null}
        {items.map((it) => (
          <div key={`${it.board_id}:${it.id}`} className="relative h-6" data-testid="timeline-row">
            <Link
              to="/a/$accountSlug/b/$boardId/i/$itemId"
              params={{ accountSlug: account.slug, boardId: it.board_id, itemId: it.id }}
              // Like the board's timeline bars: the vivid colour, white text at regular weight (never bold).
              className="absolute inset-y-0.5 flex min-w-6 items-center truncate rounded-[6px] px-1.5 text-[0.6875rem] text-white"
              style={{
                insetInlineStart: `${((dayNum(it.from) - min) / span) * 100}%`,
                width: `${((dayNum(it.to) + 1 - dayNum(it.from)) / span) * 100}%`,
                background: paint(it.color) ?? 'var(--viz-1)',
              }}
              title={`${underParent(it)} · ${formatDate(it.from)} – ${formatDate(it.to)}`}
              onClick={opener(openItem, it.board_id, it.id)}
            >
              <span className="truncate">{it.name}</span>
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
};

// ---- workload ----
type WorkloadData = {
  series: { key: string; label: string; color: string | null }[];
  people: { id: string; name: string; total: number; values: Record<string, number> }[];
};
const WorkloadView = ({ data, onDrill }: ViewProps<WorkloadData>) => {
  const d = data.data;
  if (!d.people.length) return <Empty />;
  const max = Math.max(...d.people.map((p) => p.total), 1);
  const series = d.series.map((s, i) => ({ ...s, fill: paint(s.color) ?? slot(i) }));
  return (
    <div className="viz flex h-full flex-col gap-1.5 overflow-auto" data-testid="widget-workload">
      {d.people.map((p) => (
        <div key={p.id} className="flex items-center gap-2 text-xs" data-testid="workload-row" data-total={p.total}>
          <span
            className={cn(
              'w-28 shrink-0 truncate text-fg-2',
              onDrill && 'cursor-pointer hover:text-fg hover:underline',
            )}
            {...drillProps(onDrill, { person: p.id }, p.id === EMPTY ? t('dashboards.unassigned') : p.name)}
          >
            {p.id === EMPTY ? t('dashboards.unassigned') : p.name}
          </span>
          <div className="flex h-4 flex-1 gap-[0.125rem]">
            {series.map((s) =>
              p.values[s.key] ? (
                <div
                  key={s.key}
                  className={cn(
                    'h-full first:rounded-s-[4px] last:rounded-e-[4px]',
                    onDrill && 'cursor-pointer hover:opacity-80',
                  )}
                  style={{ width: `${(p.values[s.key]! / max) * 100}%`, background: s.fill }}
                  {...drillProps(
                    onDrill,
                    { person: p.id, series: s.key },
                    `${p.id === EMPTY ? t('dashboards.unassigned') : p.name}${s.label ? ` · ${s.label}` : ''}`,
                  )}
                  title={`${p.id === EMPTY ? t('dashboards.unassigned') : p.name}${s.label ? ` · ${s.label}` : ''}: ${compact(p.values[s.key]!)}`}
                />
              ) : null,
            )}
          </div>
          <span className="w-12 shrink-0 text-end font-normal text-fg tabular-nums">{compact(p.total)}</span>
        </div>
      ))}
      <Legend items={series.length > 1 ? series.map((s) => ({ label: bucketLabel(s), color: s.fill })) : []} />
    </div>
  );
};

// ---- time report ----
type TimeData = {
  from: string | null;
  to: string | null;
  total_s: number;
  billable_s: number;
  rows: { key: string; label: string; duration_s: number; billable_s: number; entries: number }[];
};
const TimeReportView = ({ data }: ViewProps<TimeData>) => {
  const d = data.data;
  const max = Math.max(...d.rows.map((r) => r.duration_s), 1);
  return (
    <div className="viz flex h-full flex-col" data-testid="widget-time-report">
      <div className="mb-2 flex items-baseline gap-3">
        <span
          className="text-2xl font-bold text-heading tabular-nums"
          data-testid="time-report-total"
          data-seconds={d.total_s}
        >
          {formatDuration(d.total_s)}
        </span>
        <span className="text-xs text-muted">
          {t('dashboards.time.billable')}: {formatDuration(d.billable_s)}
        </span>
        {d.from || d.to ? (
          <span className="ms-auto text-xs text-muted">
            {d.from ? formatDate(d.from) : ''} – {d.to ? formatDate(d.to) : ''}
          </span>
        ) : null}
      </div>
      {!d.rows.length ? (
        <Empty />
      ) : (
        <ul className="min-h-0 flex-1 space-y-1 overflow-auto">
          {d.rows.map((r) => (
            <li
              key={r.key}
              className="flex items-center gap-2 text-xs"
              data-testid="time-report-row"
              data-label={r.label}
            >
              <span className="w-28 shrink-0 truncate text-fg-2">
                {r.key === EMPTY ? t('dashboards.none') : r.label}
              </span>
              <div className="h-3 flex-1">
                <div
                  className="h-full rounded-e-[4px] bg-[var(--viz-1)]"
                  style={{ width: `${(r.duration_s / max) * 100}%` }}
                />
              </div>
              <span className="w-16 shrink-0 text-end font-normal text-fg tabular-nums">
                {formatDuration(r.duration_s)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// ---- text ----
const TextView = ({ widget }: { widget: Widget }) => {
  const text = (widget.settings as { text?: string }).text ?? '';
  return text ? (
    <div className="h-full overflow-auto text-sm leading-relaxed whitespace-pre-wrap text-fg" data-testid="widget-text">
      {text}
    </div>
  ) : (
    <Empty>{t('dashboards.text.empty')}</Empty>
  );
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyView = (p: ViewProps<any>) => ReactNode;
export const WIDGET_VIEWS: Record<string, AnyView> = {
  numbers: NumbersView,
  battery: BatteryView,
  chart: ChartView,
  table: TableView,
  board_view: TableView,
  calendar: CalendarView,
  timeline: TimelineView,
  workload: WorkloadView,
  time_report: TimeReportView,
};
export { TextView };
/** The chart drawing, reused by the board's Chart view (M8 ד9). */
export { ChartView as ChartDrawing };
