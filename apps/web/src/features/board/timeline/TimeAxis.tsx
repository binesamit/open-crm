// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from 'react';
import {
  addDays,
  type Axis,
  type AxisUnit,
  axisColumns,
  axisSkips,
  axisWidth,
  dayMarksText,
  dayOfColumn,
  isHiddenDay,
  formatHebrew,
  formatMonthYear,
  HEADER_UNITS,
  isWeekend,
  parseIso,
  quarterOf,
  regionDay,
  showHebrewDates,
  t,
  ticks,
  xOf,
  ZOOMS,
  type DayInfo,
  type MessageKey,
  type Zoom,
} from '@bines/shared';
import { cn, DAY_MARK_CLASS, DAY_STATE_BG } from '@bines/ui';
import { Icon } from '../../../lib/icons';

/**
 * The shared time axis UI (M8 ד6): header rows, the background (weekends of the account, unit lines, today), and
 * the zoom / navigation controls — used by Timeline, Gantt and Workload (and later dashboard widgets). Everything
 * is placed from the inline start, so RTL runs right-to-left with no special case.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** A header cell's text for a unit starting at `iso`. */
export const unitLabel = (iso: string, unit: AxisUnit, major: boolean): string => {
  const p = parseIso(iso);
  switch (unit) {
    case 'day':
      return String(p.day);
    case 'week':
      return `${pad(p.day)}/${pad(p.month + 1)}`;
    case 'month':
      return major ? formatMonthYear(p.year, p.month) : formatMonthYear(p.year, p.month).split(' ')[0]!;
    case 'quarter':
      return t('timeline.quarter', { n: quarterOf(iso) });
    case 'year':
      return String(p.year);
  }
};

export const HEADER_ROW_PX = 26;
/** The thin band of holiday names under the header (day / week zoom, when the axis has any). */
export const HOLIDAY_BAND_PX = 18;

/** A run of consecutive days with the same holidays (one name over them all in the band). */
export type HolidayRun = { from: string; days: number; name: string; state: NonNullable<DayInfo['state']> };

/**
 * Holidays and the account's own days on the axis, in the day and week zooms only (wider zooms
 * have no room for a day): consecutive days with the same names are one run. Walked by column, so a collapsed
 * axis ("working days only") has runs of its visible days only; `days` counts columns.
 */
export const holidayRuns = (axis: Axis): HolidayRun[] => {
  if (axis.zoom !== 'day' && axis.zoom !== 'week') return [];
  const out: HolidayRun[] = [];
  let lastCol = -2;
  const cols = axisColumns(axis);
  for (let i = 0; i < cols; i++) {
    const d = dayOfColumn(axis, i);
    const info = regionDay(d);
    if (!info.state) continue;
    const name = dayMarksText(d);
    const last = out.at(-1);
    if (last && last.name === name && lastCol === i - 1) last.days++;
    else out.push({ from: d, days: 1, name, state: info.state });
    lastCol = i;
  }
  return out;
};

/** A "days skipped here" marker of a collapsed axis: where it sits and what it left out. */
export type SkipMark = { x: number; from: string; text: string };

/**
 * Where a "working days only" axis left days out and what: the holidays' names (the shared
 * engine's `dayMarksText`), "weekend" for a plain weekend. Only when a day is wide enough to tell (day / week zoom).
 */
export const skipMarks = (axis: Axis, weekend: 'fri_sat' | 'sat_sun'): SkipMark[] => {
  if (axis.pxPerDay < 16) return [];
  return axisSkips(axis).map((k) => {
    const names: string[] = [];
    for (const d of k.days) {
      const name = dayMarksText(d) || (isWeekend(d, weekend) ? t('workdays.weekend') : '');
      if (name && !names.includes(name)) names.push(name);
    }
    return {
      x: k.col * axis.pxPerDay,
      from: k.days[0]!,
      text: t('workdays.skipped', { days: names.join(' · ') || k.days.join(', ') }),
    };
  });
};

/** The header's height: two rows, and the holiday band when the axis has holidays. */
export const axisHeaderHeight = (runs: HolidayRun[]) => HEADER_ROW_PX * 2 + (runs.length ? HOLIDAY_BAND_PX : 0);

/**
 * The header rows (major above, minor below) and the holiday band, as wide as the axis. In the day zoom the
 * Hebrew day is under each day number when the account shows Hebrew dates.
 */
export const AxisHeader = ({
  axis,
  today,
  runs = [],
  skips = [],
}: {
  axis: Axis;
  today: string;
  /** `holidayRuns(axis)` — passed in so the chart and the header share one walk of the axis. */
  runs?: HolidayRun[];
  /** `skipMarks(axis)` of a collapsed axis: a dashed marker with the skipped days in its tooltip. */
  skips?: SkipMark[];
}) => {
  const { major, minor } = HEADER_UNITS[axis.zoom];
  const majors = useMemo(() => ticks(axis, major), [axis, major]);
  const minors = useMemo(() => (major === minor ? [] : ticks(axis, minor)), [axis, major, minor]);
  const hebrew = minor === 'day' && showHebrewDates('calendars');
  const todayX = xOf(axis, today);
  return (
    <div className="relative bg-surface-3" style={{ width: axisWidth(axis), height: axisHeaderHeight(runs) }}>
      {majors.map((tk) => (
        <div
          key={`M${tk.start}`}
          className="absolute top-0 truncate border-s border-line px-2 text-xs leading-[1.625rem] font-normal text-heading"
          style={{ insetInlineStart: tk.offset, width: tk.width, height: HEADER_ROW_PX }}
        >
          {unitLabel(tk.start, major, true)}
        </div>
      ))}
      {minors.map((tk) => {
        const current = todayX >= tk.offset && todayX < tk.offset + tk.width;
        return (
          <div
            key={`m${tk.start}`}
            data-testid="axis-tick"
            data-day={tk.start}
            className={cn(
              'absolute flex flex-col items-center justify-center truncate border-s border-t border-line-soft text-[0.6875rem] text-muted tabular-nums',
              hebrew && 'leading-none',
              current && 'font-normal text-primary',
            )}
            style={{ insetInlineStart: tk.offset, width: tk.width, top: HEADER_ROW_PX, height: HEADER_ROW_PX }}
          >
            {tk.width >= 18 ? unitLabel(tk.start, minor, false) : null}
            {hebrew && tk.width >= 18 ? (
              <span data-testid="axis-hebrew-day" className="mt-px text-[0.5625rem] font-normal opacity-80">
                {formatHebrew(tk.start, 'day')}
              </span>
            ) : null}
          </div>
        );
      })}
      {runs.map((r) => (
        <div
          key={`h${r.from}`}
          data-testid="axis-holiday"
          data-day={r.from}
          data-day-state={r.state}
          title={r.name}
          className={cn(
            'absolute truncate rounded-[4px] px-1 text-center text-[0.625rem] leading-[0.875rem] font-normal',
            DAY_MARK_CLASS[r.state],
          )}
          style={{
            insetInlineStart: xOf(axis, r.from) + 1,
            width: r.days * axis.pxPerDay - 2,
            top: HEADER_ROW_PX * 2 + 2,
            height: HOLIDAY_BAND_PX - 4,
          }}
        >
          {r.days * axis.pxPerDay >= 24 ? r.name : null}
        </div>
      ))}
      {skips.map((k) => (
        <div
          key={`s${k.from}`}
          data-testid="axis-skip"
          data-day={k.from}
          data-tip={k.text}
          aria-label={k.text}
          role="img"
          className="absolute top-0 z-[1] flex w-2.5 cursor-help justify-center"
          style={{ insetInlineStart: k.x - 5, height: axisHeaderHeight(runs) }}
        >
          <span className="h-full border-s border-dashed border-muted" />
        </div>
      ))}
    </div>
  );
};

/**
 * The background under the rows: weekend days shaded (day / week zoom), a line at every minor unit and the today
 * marker. One layer for all rows (not per row).
 */
export const AxisBackground = ({
  axis,
  today,
  weekend,
  height,
  runs = [],
  skips = [],
}: {
  axis: Axis;
  today: string;
  weekend: 'fri_sat' | 'sat_sun';
  height: number;
  /** Holidays shaded by their state (`holidayRuns(axis)`); a marked working day is not shaded. */
  runs?: HolidayRun[];
  /** `skipMarks(axis)` of a collapsed axis: a dashed line down the rows where days were left out. */
  skips?: SkipMark[];
}) => {
  const { minor } = HEADER_UNITS[axis.zoom];
  const lines = useMemo(() => ticks(axis, minor), [axis, minor]);
  const weekends = useMemo(() => {
    if (axis.zoom !== 'day' && axis.zoom !== 'week') return [];
    const out: string[] = [];
    for (let i = 0; i < axis.days; i++) {
      const d = addDays(axis.start, i);
      if (isWeekend(d, weekend) && !isHiddenDay(axis, d)) out.push(d);
    }
    return out;
  }, [axis, weekend]);
  const todayX = xOf(axis, today);
  const showToday = todayX >= 0 && todayX < axisWidth(axis);
  return (
    <div className="pointer-events-none absolute top-0" style={{ width: axisWidth(axis), height }} aria-hidden>
      {weekends.map((d) => (
        <div
          key={d}
          data-weekend={d}
          className="absolute top-0 bg-[color-mix(in_srgb,var(--surface-3)_70%,var(--line-soft))]"
          style={{ insetInlineStart: xOf(axis, d), width: axis.pxPerDay, height }}
        />
      ))}
      {runs.map((r) =>
        DAY_STATE_BG[r.state] ? (
          <div
            key={`h${r.from}`}
            data-holiday={r.from}
            data-day-state={r.state}
            className={cn('absolute top-0 opacity-70', DAY_STATE_BG[r.state])}
            style={{ insetInlineStart: xOf(axis, r.from), width: r.days * axis.pxPerDay, height }}
          />
        ) : null,
      )}
      {lines.map((tk) => (
        <div
          key={tk.start}
          className="absolute top-0 border-s border-line-soft"
          style={{ insetInlineStart: tk.offset, height }}
        />
      ))}
      {skips.map((k) => (
        <div
          key={`s${k.from}`}
          data-skip={k.from}
          className="absolute top-0 border-s border-dashed border-muted opacity-60"
          style={{ insetInlineStart: k.x, height }}
        />
      ))}
      {showToday ? (
        <div
          data-testid="timeline-today"
          className="absolute top-0 w-0.5 bg-accent"
          style={{ insetInlineStart: todayX + axis.pxPerDay / 2 - 1, height }}
        />
      ) : null}
    </div>
  );
};

const navButton =
  'grid size-8 place-items-center rounded-[10px] border border-line-strong bg-surface text-heading hover:bg-surface-2';

/** [prev][today][next] and the zoom switch (F4: like the calendar's month / week toggle). */
export const AxisControls = ({
  zoom,
  onZoom,
  onPrev,
  onNext,
  onToday,
  zooms = ZOOMS,
  children,
}: {
  zoom: string;
  onZoom: (z: Zoom) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  zooms?: readonly string[];
  /** Extra controls between the navigation and the zoom (a Gantt's "critical path"…). */
  children?: React.ReactNode;
}) => (
  <div className="mb-3 flex flex-wrap items-center gap-2 max-md:gap-1.5">
    <button type="button" aria-label={t('calendar.prev')} onClick={onPrev} className={navButton}>
      <Icon name="chevronStart" size={15} />
    </button>
    <button
      type="button"
      data-testid="timeline-today-button"
      onClick={onToday}
      className="h-8 rounded-[10px] border border-line-strong bg-surface px-2.5 text-sm text-heading hover:bg-surface-2"
    >
      {t('calendar.today')}
    </button>
    <button type="button" aria-label={t('calendar.next')} onClick={onNext} className={navButton}>
      <Icon name="chevronEnd" size={15} />
    </button>
    {children}
    <div
      className="ms-auto flex gap-0.5 rounded-[12px] bg-surface-2 p-[0.1875rem] text-sm max-md:text-xs"
      data-testid="timeline-zoom"
    >
      {zooms.map((z) => (
        <button
          key={z}
          type="button"
          aria-pressed={zoom === z}
          data-zoom={z}
          onClick={() => onZoom(z as Zoom)}
          className={cn(
            'h-[1.875rem] rounded-[9px] px-3 max-md:h-[1.625rem] max-md:px-2',
            zoom === z ? 'bg-primary font-semibold text-on-primary' : 'text-fg-2 hover:text-fg',
          )}
        >
          {t(`timeline.zoom.${z}` as MessageKey)}
        </button>
      ))}
    </div>
  </div>
);

/** The writing direction of an element (pointer math needs it; layout never does). */
export const dirOf = (el: Element | null): 'rtl' | 'ltr' =>
  el && getComputedStyle(el).direction === 'rtl' ? 'rtl' : 'ltr';
