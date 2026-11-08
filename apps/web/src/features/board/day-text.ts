// SPDX-License-Identifier: AGPL-3.0-only
import type { CSSProperties } from 'react';
import {
  durationMode,
  formatHebrew,
  regionCountDays,
  showHebrewDates,
  t,
  type DurationMode,
  type IsoDate,
  type TimelineSettings,
} from '@bines/shared';

/**
 * Hebrew dates and counted durations in board cells and bars — one rule for the date cell, the
 * timeline cell and the timeline / Gantt bar.
 */

/** A column's "Hebrew date" setting: 'on' / 'off', or (unset / 'account') the account's "also in table cells". */
export const cellShowsHebrew = (own?: 'account' | 'on' | 'off' | null) =>
  own === 'on' || (own !== 'off' && showHebrewDates('cells'));

/** The Hebrew date of a cell's second line ("ט׳ בתשרי"), or of a range ("ט׳ בתשרי – י״ב בתשרי"). */
export const cellHebrewText = (from: IsoDate, to: IsoDate = from) =>
  from === to
    ? formatHebrew(from, 'day_month')
    : `${formatHebrew(from, 'day_month')} – ${formatHebrew(to, 'day_month')}`;

/** "8.5 ימי עבודה" / "יום עבודה אחד" in a working-day mode; "8 ימים" / "יום אחד" in calendar days. */
export const durationText = (n: number, mode: DurationMode) => {
  if (mode === 'calendar') return n === 1 ? t('timeline.oneDay') : t('timeline.days', { n });
  return n === 1 ? t('workdays.one') : t('workdays.count', { n: Math.round(n * 10) / 10 });
};

/** A timeline span's counted length in its column's mode (the column's own, else the account's). */
export const spanDuration = (from: IsoDate, to: IsoDate, settings: TimelineSettings | null | undefined) => {
  const mode = durationMode(settings?.duration);
  const n = regionCountDays(from, to, mode);
  return { n, mode, text: durationText(n, mode) };
};

/** Whether a timeline shows its counted length: asked for, or counted in anything but calendar days. */
export const showsDuration = (settings: TimelineSettings | null | undefined) =>
  !!settings?.show_duration || durationMode(settings?.duration) !== 'calendar';

/**
 * The fill of a day that counts less than one inside a working-day bar: a weekend / day off is a
 * hatched hole in the bar's own colour, a half day a lighter slice of it. Over the surface token, so it reads in
 * light and dark.
 */
export const gapFill = (color: string, weight: number): CSSProperties =>
  weight > 0
    ? { backgroundColor: `color-mix(in srgb, ${color} 60%, var(--surface))` }
    : {
        backgroundColor: 'var(--surface)',
        backgroundImage: `repeating-linear-gradient(135deg, color-mix(in srgb, ${color} 50%, transparent) 0 3px, transparent 3px 6px)`,
      };
