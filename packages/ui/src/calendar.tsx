// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  dayMarksText,
  formatDate,
  formatHebrew,
  formatHebrewMonths,
  formatMonthName,
  formatMonthYear,
  getRegion,
  inRange,
  isWeekendDate,
  monthGrid,
  parseIso,
  pickRange,
  regionDay,
  shiftMonth,
  showDayMarks,
  showHebrewDates,
  t,
  todayIn,
  weekdayNames,
  weekendDays,
  type DateRange,
  type DayInfo,
  type IsoDate,
  type Region,
} from '@bines/shared';
import { cn } from './components';

/**
 * Month calendar (11-UI-DESIGN: DatePicker) for date and timeline cells — replaces <input type="date">.
 * Range mode: 1st click = start, 2nd = end, a 3rd starts over.
 * Arrows move by month (‹ ›) and by year (« »); the title opens a month grid.
 * Region settings (A3): weeks start on the region's first day, its weekend day numbers are muted, names follow its
 * language and "today" is today in its timezone. `weekStartsOn` overrides the first day.
 * Days off and half days are a small dot under the day number — never a fill, so the selection and
 * today keep their own colours; `dayMarks` false = no dots and no holidays at all (default: the account's setting).
 */
type CalendarProps = { weekStartsOn?: number; region?: Region; dayMarks?: boolean } & (
  | { mode: 'single'; value: IsoDate | null; onChange: (value: IsoDate | null) => void }
  | { mode: 'range'; value: DateRange; onChange: (value: DateRange) => void }
);

/** A calendar date in the region's date format (A3). */
export const formatIsoDate = (iso: IsoDate, region: Region = getRegion()) => formatDate(iso, {}, region);

/** The text colour of a holiday's name (a chip, a band) by its day's state. */
export const DAY_MARK_CLASS: Record<NonNullable<DayInfo['state']>, string> = {
  off: 'bg-danger-soft text-danger-fg',
  half: 'bg-accent-soft text-accent-fg',
  work: 'bg-primary-soft text-primary',
};

/** A day's shading alone (a calendar-view day, a timeline column) — the text keeps its own colour. */
export const DAY_STATE_BG: Record<NonNullable<DayInfo['state']>, string> = {
  off: 'bg-danger-soft',
  half: 'bg-accent-soft',
  work: '',
};

/** The colour of a day's dot by its state (a marked working day has none). */
export const DAY_DOT_CLASS: Record<'off' | 'half', string> = {
  off: 'bg-danger-fg',
  half: 'bg-accent-fg',
};

/**
 * A day off / half day as a small round dot (the approved canvas, board י option 2): red = off, orange = half. Its
 * meaning is in the day's title / description, so the dot itself is hidden from screen readers.
 */
export const DayDot = ({ state, className }: { state: 'off' | 'half'; className?: string }) => (
  <span
    aria-hidden
    data-testid="day-dot"
    data-state={state}
    className={cn('inline-block size-[5px] shrink-0 rounded-full', DAY_DOT_CLASS[state], className)}
  />
);

/** The dot a day gets: only off and half days; a marked working day or an ordinary day = none. */
export const dayDotState = (state: DayInfo['state']): 'off' | 'half' | null =>
  state === 'off' || state === 'half' ? state : null;

/**
 * The line under the picker for a chosen day: its Hebrew date when Hebrew dates are on, and its
 * holidays ("ט׳ בתשרי תשפ״ז · ערב יום כיפור"); '' = nothing to say. `marks` false = without the holidays.
 */
export const dayFootnote = (iso: IsoDate, region: Region = getRegion(), marks = true) =>
  [
    showHebrewDates('calendars', region) ? formatHebrew(iso, 'full', region) : '',
    marks ? dayMarksText(iso, region) : '',
  ]
    .filter(Boolean)
    .join(' · ');

const NavButton = ({ label, glyph, onClick }: { label: string; glyph: string; onClick: () => void }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
    className="flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-muted hover:bg-surface-2 hover:text-fg"
  >
    <span className="rtl:-scale-x-100">{glyph}</span>
  </button>
);

export const Calendar = (props: CalendarProps) => {
  const region = props.region ?? getRegion();
  const weekStartsOn = props.weekStartsOn ?? region.first_day;
  const weekend = weekendDays(region);
  const today = todayIn(region);
  const anchor = (props.mode === 'single' ? props.value : (props.value.from ?? props.value.to)) ?? today;
  const [view, setView] = useState(() => {
    const { year, month } = parseIso(anchor);
    return { year, month };
  });
  const [picking, setPicking] = useState<'days' | 'months'>('days');
  const [hover, setHover] = useState<IsoDate | null>(null);

  const range: DateRange = props.mode === 'range' ? props.value : { from: props.value, to: props.value };
  // While only a start is chosen, hovering previews the range to that day.
  const preview: DateRange =
    props.mode === 'range' && range.from && !range.to && hover
      ? hover < range.from
        ? { from: hover, to: range.from }
        : { from: range.from, to: hover }
      : range;
  const nextTarget = props.mode === 'range' && range.from && !range.to ? 'to' : 'from';

  const move = (months: number) => setView((v) => shiftMonth(v.year, v.month, months));
  const pick = (iso: IsoDate) => {
    if (props.mode === 'single') props.onChange(iso);
    else props.onChange(pickRange(props.value, iso));
  };

  // Weekday names come from Intl so they follow the language; the order starts on the week's first day.
  const weekdays = weekdayNames('narrow', { ...region, first_day: weekStartsOn });
  const grid = monthGrid(view.year, view.month, weekStartsOn);
  // Hebrew dates: a letter under each day and the Hebrew months under the title. Off = the grid
  // keeps its compact rows.
  const hebrew = showHebrewDates('calendars', region);
  // Days off / half days as dots (the account's setting unless the caller — a column — says otherwise).
  const marksOn = props.dayMarks ?? showDayMarks(undefined, region);
  const inMonth = grid.filter((d) => d.inMonth);
  const footIso = props.mode === 'single' ? props.value : (props.value.from ?? null);
  const footnote = footIso ? dayFootnote(footIso, region, marksOn) : '';

  return (
    <div className="w-72 select-none space-y-2" onMouseLeave={() => setHover(null)}>
      {props.mode === 'range' ? (
        <div className="grid grid-cols-2 gap-2 text-xs">
          {(['from', 'to'] as const).map((k) => (
            <div
              key={k}
              data-testid={`range-${k}`}
              className={cn(
                'rounded-[var(--radius-sm)] border px-2 py-1',
                nextTarget === k ? 'border-primary ring-2 ring-[var(--primary-soft)]' : 'border-line',
              )}
            >
              <div className="text-muted">{t(k === 'from' ? 'calendar.start' : 'calendar.end')}</div>
              <div dir="ltr" className="text-end font-medium text-fg">
                {props.value[k] ? formatIsoDate(props.value[k], region) : '—'}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-0.5">
        <NavButton label={t('calendar.prevYear')} glyph="«" onClick={() => move(-12)} />
        {picking === 'days' ? <NavButton label={t('calendar.prevMonth')} glyph="‹" onClick={() => move(-1)} /> : null}
        <button
          type="button"
          onClick={() => setPicking((p) => (p === 'days' ? 'months' : 'days'))}
          className="flex-1 rounded-[var(--radius-sm)] py-1 text-sm font-semibold text-fg hover:bg-surface-2"
          aria-label={t('calendar.chooseMonth')}
        >
          {picking === 'days' ? formatMonthYear(view.year, view.month, region) : view.year}
          {hebrew && picking === 'days' && inMonth.length ? (
            <span data-testid="calendar-hebrew-months" className="block text-xs font-normal text-muted">
              {formatHebrewMonths(inMonth[0]!.iso, inMonth[inMonth.length - 1]!.iso, region)}
            </span>
          ) : null}
        </button>
        {picking === 'days' ? <NavButton label={t('calendar.nextMonth')} glyph="›" onClick={() => move(1)} /> : null}
        <NavButton label={t('calendar.nextYear')} glyph="»" onClick={() => move(12)} />
      </div>

      {picking === 'months' ? (
        <div className="grid grid-cols-3 gap-1">
          {Array.from({ length: 12 }, (_, m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setView((v) => ({ year: v.year, month: m }));
                setPicking('days');
              }}
              className={cn(
                'rounded-[var(--radius-sm)] py-2 text-sm hover:bg-surface-2',
                m === view.month ? 'bg-primary-soft font-medium text-primary' : 'text-fg',
              )}
            >
              {formatMonthName(m, 'short', region)}
            </button>
          ))}
        </div>
      ) : (
        <div role="grid" className="grid grid-cols-7 gap-y-0.5 text-center text-sm">
          {weekdays.map((w, i) => (
            <div
              key={i}
              data-weekend={weekend.includes((i + weekStartsOn) % 7) || undefined}
              className="py-1 text-xs text-muted"
            >
              {w}
            </div>
          ))}
          {grid.map(({ iso, inMonth: here }) => {
            const isEdge = iso === preview.from || iso === preview.to;
            const within = inRange(iso, preview.from, preview.to);
            const off = isWeekendDate(iso, region);
            // Holidays and the account's own days: a dot by state, named in the tooltip.
            const day = marksOn ? regionDay(iso, region) : null;
            const marks = day?.marks.length ? dayMarksText(iso, region) : '';
            const dotState = day && !isEdge ? dayDotState(day.state) : null;
            const dot = dotState ? <DayDot state={dotState} /> : null;
            return (
              <button
                key={iso}
                type="button"
                data-iso={iso}
                data-weekend={off || undefined}
                data-day-state={day?.state ?? undefined}
                // The name stays the date (pickers are found by it); the holidays are its description.
                aria-label={formatIsoDate(iso, region)}
                aria-description={marks || undefined}
                title={marks || undefined}
                aria-pressed={iso === range.from || iso === range.to}
                onClick={() => pick(iso)}
                onMouseEnter={() => setHover(iso)}
                className={cn(
                  // With Hebrew dates the dot sits beside the letter; without, its own line is always reserved so
                  // a month with holidays is as tall as one without.
                  hebrew
                    ? 'flex h-10 flex-col items-center justify-center leading-tight'
                    : marksOn
                      ? 'flex h-9 flex-col items-center justify-center gap-0.5 leading-none'
                      : 'h-8',
                  'text-sm',
                  within && !isEdge && 'bg-primary-soft',
                  // The region's weekend (A3): a muted number, never a fill, under the range and selection colours.
                  off && !within && !isEdge && 'text-muted',
                  isEdge ? 'rounded-[var(--radius-sm)] bg-primary font-semibold text-on-primary' : 'hover:bg-surface-2',
                  !here && !isEdge && (within ? 'text-fg-2' : 'text-muted'),
                  iso === today && !isEdge && 'font-semibold text-primary',
                )}
              >
                <span className={cn(iso === today && !isEdge && 'underline underline-offset-4')}>
                  {parseIso(iso).day}
                </span>
                {hebrew ? (
                  <span className="inline-flex items-center gap-0.5">
                    <span
                      data-testid="hebrew-day"
                      className={cn('text-[10px] font-normal', isEdge ? 'opacity-80' : 'opacity-70')}
                    >
                      {formatHebrew(iso, 'day', region)}
                    </span>
                    {dot}
                  </span>
                ) : marksOn ? (
                  <span className="flex h-[5px] items-center">{dot}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      {footnote ? (
        <div data-testid="calendar-footnote" className="truncate text-center text-xs text-muted" title={footnote}>
          {footnote}
        </div>
      ) : null}

      <div className="flex justify-between border-t border-line pt-2 text-xs">
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => {
            const { year, month } = parseIso(today);
            setView({ year, month });
            setPicking('days');
            if (props.mode === 'single') props.onChange(today);
          }}
        >
          {t('calendar.today')}
        </button>
        <button
          type="button"
          className="text-muted hover:text-fg"
          onClick={() => (props.mode === 'single' ? props.onChange(null) : props.onChange({ from: null, to: null }))}
        >
          {t('board.clear')}
        </button>
      </div>
    </div>
  );
};
