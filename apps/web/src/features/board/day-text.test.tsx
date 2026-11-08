// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Axis,
  DEFAULT_CALENDAR,
  DEFAULT_REGION,
  getRegion,
  setRegion,
  showDayMarks,
  workdaysOnlyAxis,
  type Region,
} from '@bines/shared';
import { Calendar, dayFootnote } from '@bines/ui';
import { cellHebrewText, cellShowsHebrew, durationText, gapFill, showsDuration, spanDuration } from './day-text';
import { holidayRuns, skipMarks } from './timeline/TimeAxis';

/** Hebrew dates, holidays and counted days on the date surfaces. */
const region = (hebrew: Region['calendar']['hebrew_dates'], duration = DEFAULT_CALENDAR.duration): Region => ({
  ...DEFAULT_REGION,
  calendar: { ...DEFAULT_CALENDAR, hebrew_dates: hebrew, duration },
});

let saved: Region;
beforeEach(() => {
  saved = getRegion();
});
afterEach(() => setRegion(saved));

describe('cell rules', () => {
  it('shows the Hebrew date by the column, else by the account', () => {
    setRegion(region('calendars'));
    expect(cellShowsHebrew(undefined)).toBe(false);
    expect(cellShowsHebrew('account')).toBe(false);
    expect(cellShowsHebrew('on')).toBe(true);
    setRegion(region('cells'));
    expect(cellShowsHebrew('account')).toBe(true);
    expect(cellShowsHebrew('off')).toBe(false);
    expect(cellHebrewText('2026-09-20')).toBe('ט׳ בתשרי');
    expect(cellHebrewText('2026-09-20', '2026-09-21')).toBe('ט׳ בתשרי – י׳ בתשרי');
  });

  it('counts a span in the column’s mode, else the account’s', () => {
    setRegion(region('off', 'workdays'));
    // Sun 20 Sep (erev Yom Kippur, half) – Thu 24 Sep 2026 (Yom Kippur off): ½ + 0 + 3.
    expect(spanDuration('2026-09-20', '2026-09-24', {}).text).toBe('3.5 ימי עבודה');
    expect(spanDuration('2026-09-20', '2026-09-24', { duration: 'calendar' }).text).toBe('5 ימים');
    expect(spanDuration('2026-09-22', '2026-09-22', { duration: 'weekdays' }).text).toBe(durationText(1, 'weekdays'));
    expect(showsDuration({})).toBe(true); // the account counts working days
    expect(showsDuration({ duration: 'calendar' })).toBe(false);
    expect(showsDuration({ duration: 'calendar', show_duration: true })).toBe(true);
  });
});

describe('day marks in the picker', () => {
  it('follows the column, else the account', () => {
    const dots = region('off');
    const none: Region = { ...dots, calendar: { ...dots.calendar, picker_marks: 'none' } };
    expect(showDayMarks(undefined, dots)).toBe(true);
    expect(showDayMarks('account', dots)).toBe(true);
    expect(showDayMarks('off', dots)).toBe(false);
    expect(showDayMarks(undefined, none)).toBe(false);
    expect(showDayMarks('on', none)).toBe(true);
    setRegion(none);
    expect(showDayMarks()).toBe(false);
  });
});

describe('working-day gaps and the collapsed axis', () => {
  it('fills a hole hatched and a half day lighter, from the bar colour and the surface token', () => {
    expect(gapFill('#123456', 0).backgroundImage).toContain('repeating-linear-gradient');
    expect(gapFill('#123456', 0).backgroundColor).toBe('var(--surface)');
    expect(gapFill('#123456', 0.5).backgroundColor).toContain('var(--surface)');
  });

  it('names what a working-days-only axis skipped, and shades only visible holidays', () => {
    setRegion(region('off', 'workdays'));
    const plain: Axis = { start: '2026-09-01', days: 30, pxPerDay: 40, zoom: 'day', firstDay: 0 };
    const axis = workdaysOnlyAxis(plain, DEFAULT_CALENDAR, 'fri_sat');
    const marks = skipMarks(axis, 'fri_sat');
    const yk = marks.find((k) => k.from === '2026-09-21')!;
    expect(yk.text).toBe('דולגו: יום כיפור');
    expect(marks.find((k) => k.from === '2026-09-04')!.text).toBe('דולגו: סוף שבוע');
    expect(skipMarks(plain, 'fri_sat')).toEqual([]);
    // Erev Yom Kippur (half) stays on the axis; Yom Kippur (off) has no column, so no run.
    const runs = holidayRuns(axis);
    expect(runs.map((r) => r.from)).toContain('2026-09-20');
    expect(runs.map((r) => r.from)).not.toContain('2026-09-21');
    expect(holidayRuns(plain).map((r) => r.from)).toContain('2026-09-21');
  });
});

describe('date picker', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const mount = (r: Region, value: string, dayMarks?: boolean) =>
    act(() =>
      root.render(createElement(Calendar, { mode: 'single', value, onChange: () => undefined, region: r, dayMarks })),
    );

  it('shows Hebrew days, the Hebrew months and the chosen day’s line when on', async () => {
    await mount(region('calendars'), '2026-09-20');
    expect(host.querySelectorAll('[data-testid="hebrew-day"]')).toHaveLength(42);
    expect(host.querySelector('[data-testid="calendar-hebrew-months"]')?.textContent).toBe('אלול תשפ״ו – תשרי תשפ״ז');
    expect(host.querySelector('[data-testid="calendar-footnote"]')?.textContent).toBe('ט׳ בתשרי תשפ״ז · ערב יום כיפור');
    const yk = host.querySelector('[data-iso="2026-09-21"]')!;
    expect(yk.getAttribute('data-day-state')).toBe('off');
    expect(yk.getAttribute('title')).toBe('יום כיפור');
    expect(host.querySelector('[data-iso="2026-09-20"]')!.getAttribute('data-day-state')).toBe('half');
  });

  it('keeps the compact grid when off, still naming holidays', async () => {
    await mount(region('off'), '2026-09-20');
    expect(host.querySelector('[data-testid="hebrew-day"]')).toBeNull();
    expect(host.querySelector('[data-testid="calendar-hebrew-months"]')).toBeNull();
    expect(host.querySelector('[data-testid="calendar-footnote"]')?.textContent).toBe('ערב יום כיפור');
    // The dot's line is reserved on every day, so a month with holidays is as tall as one without.
    expect(host.querySelector('[data-iso="2026-09-21"]')!.className).toContain('h-9');
    expect(host.querySelector('[data-iso="2026-09-15"]')!.className).toContain('h-9');
    expect(dayFootnote('2026-09-15', region('off'))).toBe('');
  });

  it('marks days off and half days with a dot, never a fill', async () => {
    await mount(region('calendars'), '2026-09-15');
    const yk = host.querySelector('[data-iso="2026-09-21"]')!;
    expect(yk.querySelector('[data-testid="day-dot"]')?.getAttribute('data-state')).toBe('off');
    expect(yk.className).not.toContain('bg-danger-soft');
    // With Hebrew dates the dot sits beside the letter (the cell keeps its height).
    expect(yk.querySelector('[data-testid="hebrew-day"]')?.nextElementSibling?.getAttribute('data-testid')).toBe(
      'day-dot',
    );
    const erev = host.querySelector('[data-iso="2026-09-20"]')!;
    expect(erev.querySelector('[data-testid="day-dot"]')?.getAttribute('data-state')).toBe('half');
    expect(erev.className).not.toContain('bg-accent-soft');
    expect(host.querySelector('[data-iso="2026-09-15"] [data-testid="day-dot"]')).toBeNull();
  });

  it('hides the dot on the selected day', async () => {
    await mount(region('off'), '2026-09-21');
    expect(host.querySelector('[data-iso="2026-09-21"] [data-testid="day-dot"]')).toBeNull();
    expect(host.querySelector('[data-iso="2026-09-20"] [data-testid="day-dot"]')).not.toBeNull();
    // Rosh Hashanah (a Saturday): the dot shows on a weekend too.
    expect(host.querySelector('[data-iso="2026-09-12"] [data-testid="day-dot"]')?.getAttribute('data-state')).toBe(
      'off',
    );
  });

  it('shows the weekend as a muted number, not a shade', async () => {
    await mount(region('off'), '2026-09-15');
    const sat = host.querySelector('[data-iso="2026-09-05"]')!;
    expect(sat.getAttribute('data-weekend')).toBe('true');
    expect(sat.className).toContain('text-muted');
    expect(sat.className).not.toContain('bg-surface-2 ');
    expect(host.querySelector('[data-iso="2026-09-08"]')!.className).not.toContain('text-muted');
  });

  it('shows no dots and no holidays with dayMarks off', async () => {
    await mount(region('off'), '2026-09-20', false);
    expect(host.querySelector('[data-testid="day-dot"]')).toBeNull();
    const yk = host.querySelector('[data-iso="2026-09-21"]')!;
    expect(yk.getAttribute('data-day-state')).toBeNull();
    expect(yk.className).toContain('h-8');
    expect(host.querySelector('[data-testid="calendar-footnote"]')).toBeNull();
    expect(host.querySelector('[data-iso="2026-09-05"]')!.className).toContain('text-muted');
  });

  it('takes the account’s "none" as the default', async () => {
    const r = region('off');
    await mount({ ...r, calendar: { ...r.calendar, picker_marks: 'none' } }, '2026-09-15');
    expect(host.querySelector('[data-testid="day-dot"]')).toBeNull();
  });
});
