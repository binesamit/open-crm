// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode, useContext } from 'react';
import {
  formatHebrew,
  formatLongDay,
  parseIso,
  readIds,
  regionDay,
  showDayMarks,
  showHebrewDates,
  t,
  type QueryEnv,
} from '@bines/shared';
import { Avatar, cn, DayDot, dayDotState, dayFootnote } from '@bines/ui';
import { type BoardDetail, type Item, useMembers } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { useOpenItem } from '../open-item';
import { safeField } from '../toolbar/filter-model';
import { Icon } from '../../../lib/icons';

const MAX_DOTS = 3;

/** Up to three dots in the items' colours; more items = two colours and a muted "more" dot (F4 Board-Calendar.m). */
const dotsOf = (items: Item[], colorOf: (it: Item) => string | null) => {
  const colors = items.map((it) => colorOf(it) ?? 'var(--muted)');
  return colors.length > MAX_DOTS ? [...colors.slice(0, MAX_DOTS - 1), 'var(--muted)'] : colors;
};

/** "יום ראשון, 4 אוקטובר" — the weekday, the day and the month's own name (in the region's language). */
const dayTitle = (iso: string) => formatLongDay(iso);

/**
 * N8: the calendar on phones (F4 Board-Calendar.m) — a compact month (or week) where each day shows coloured
 * dots for its items, and under it the list of the selected day's items (today by default; tap a day to pick it).
 */
export const CalendarPhone = ({
  board,
  env,
  days,
  byDay,
  colorOf,
  selected,
  onSelect,
  weekdayLetter,
  addPanel,
  onAdd,
}: {
  board: BoardDetail;
  env: QueryEnv;
  days: { iso: string; inMonth: boolean }[];
  byDay: Map<string, Item[]>;
  colorOf: (it: Item) => string | null;
  selected: string;
  onSelect: (iso: string) => void;
  weekdayLetter: (d: Date) => string;
  /** "+" on the chosen day — the same panel as an empty day's click (absent: the view offers none). */
  onAdd?: () => void;
  addPanel?: ReactNode;
}) => {
  const items = byDay.get(selected) ?? [];
  // Hebrew dates and holidays: a letter under each day, a dot by the number of a day off / half day
  // (no fill), and the chosen day's Hebrew date and holidays under its title. The account's "none" hides the marks.
  const hebrew = showHebrewDates('calendars');
  const marksOn = showDayMarks();
  const footnote = dayFootnote(selected, undefined, marksOn);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-7 overflow-hidden rounded-[14px] border border-line">
        {days.slice(0, 7).map((d) => (
          <div
            key={`dow-${d.iso}`}
            className="grid h-8 place-items-center bg-surface-3 text-xs font-semibold text-muted [&:not(:first-child)]:border-s [&:not(:first-child)]:border-line-soft"
          >
            {weekdayLetter(new Date(`${d.iso}T00:00:00Z`))}
          </div>
        ))}
        {days.map((d, i) => {
          const dayItems = byDay.get(d.iso) ?? [];
          const isToday = d.iso === env.today;
          const isSelected = d.iso === selected;
          const state = regionDay(d.iso).state;
          const dot = marksOn ? dayDotState(state) : null;
          return (
            <button
              key={d.iso}
              type="button"
              data-testid="cal-day"
              data-date={d.iso}
              data-day-state={state ?? undefined}
              aria-pressed={isSelected}
              aria-label={`${dayTitle(d.iso)}${dayItems.length ? ` · ${t('calendar.dayItemsCount', { n: dayItems.length })}` : ''}`}
              onClick={() => onSelect(d.iso)}
              className={cn(
                'flex min-h-[2.875rem] min-w-0 flex-col items-center gap-1 border-t border-line-soft py-1',
                i % 7 !== 0 && 'border-s',
                d.inMonth ? 'bg-surface text-fg' : 'bg-surface-3 text-muted',
              )}
            >
              <span
                className={cn(
                  'relative inline-grid size-6 place-items-center rounded-full text-xs tabular-nums',
                  isToday ? 'bg-accent font-bold text-on-accent' : isSelected && 'bg-primary font-bold text-on-primary',
                )}
              >
                {parseIso(d.iso).day}
                {dot ? <DayDot state={dot} className="absolute top-0.5 -end-1" /> : null}
              </span>
              {hebrew ? (
                <span className="-mt-1 text-[0.625rem] leading-none font-normal text-muted">
                  {formatHebrew(d.iso, 'day')}
                </span>
              ) : null}
              {dayItems.length ? (
                <span className="flex gap-0.5" aria-hidden>
                  {dotsOf(dayItems, colorOf).map((c, k) => (
                    <span key={k} className="size-[0.3125rem] rounded-full" style={{ backgroundColor: c }} />
                  ))}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <h3 className="flex-1 font-display text-[0.9375rem] leading-snug font-bold text-heading">
          {dayTitle(selected)}
        </h3>
        {onAdd ? (
          <span className="relative">
            <button
              type="button"
              aria-label={t('calendar.pick.title')}
              className="grid size-8 place-items-center rounded-[10px] border border-line-strong bg-surface text-heading"
              onClick={onAdd}
              data-testid="cal-day-add"
            >
              <Icon name="plus" size={16} />
            </button>
            {addPanel}
          </span>
        ) : null}
      </div>
      {footnote ? (
        <p data-testid="cal-day-hebrew" className="-mt-2 text-xs font-normal text-muted">
          {footnote}
        </p>
      ) : null}
      <DayItems board={board} env={env} items={items} colorOf={colorOf} />
    </div>
  );
};

const DayItems = ({
  board,
  env,
  items,
  colorOf,
}: {
  board: BoardDetail;
  env: QueryEnv;
  items: Item[];
  colorOf: (it: Item) => string | null;
}) => {
  const open = useOpenItem(board.id);
  const { id: accountId } = useContext(BoardAccountContext);
  const members = useMembers(accountId).data?.data ?? [];
  // The item's person: the board's first people column (whatever it is called).
  const person = board.columns
    .map((c) => safeField(c.id, env))
    .find((f) => f?.source === 'column' && f.model === 'people');
  if (!items.length)
    return (
      <div
        className="rounded-[14px] border border-line bg-surface px-3.5 py-3 text-sm text-muted"
        data-testid="cal-day-items"
      >
        {t('calendar.dayEmpty')}
      </div>
    );
  return (
    <div className="overflow-hidden rounded-[14px] border border-line" data-testid="cal-day-items">
      {items.map((it) => {
        const color = colorOf(it);
        const who = person ? members.find((x) => x.user_id === readIds(it, person)[0]) : undefined;
        return (
          <div
            key={it.id}
            role="link"
            tabIndex={0}
            data-testid="cal-day-item"
            data-item-name={it.name}
            onClick={() => open(it.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') open(it.id);
            }}
            className="flex cursor-pointer items-center gap-3 border-b border-line-soft bg-surface px-3.5 py-3 last:border-b-0 hover:bg-surface-3"
          >
            <span
              aria-hidden
              className="h-5 w-2 shrink-0 rounded-[4px]"
              style={{ backgroundColor: color ?? 'var(--status-empty)' }}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-normal text-fg" dir="auto">
              {it.name}
            </span>
            {who ? <Avatar name={who.name || who.email} url={who.avatar_url} size={24} /> : null}
          </div>
        );
      })}
    </div>
  );
};
