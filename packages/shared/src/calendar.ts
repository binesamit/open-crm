// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Calendar math for the date/timeline pickers (M1.1 #8). Dates are plain 'YYYY-MM-DD' strings —
 * never Date objects across boundaries, so no timezone can shift a day.
 */
export type IsoDate = string;
export type DateRange = { from: IsoDate | null; to: IsoDate | null };

const pad = (n: number) => String(n).padStart(2, '0');

export const isoOf = (year: number, month: number, day: number): IsoDate => {
  const d = new Date(Date.UTC(year, month, day));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** `month` is 0-based, like Date. */
export const parseIso = (iso: IsoDate): { year: number; month: number; day: number } => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return { year: y, month: m - 1, day: d };
};

/** Moves a {year, month} by `months` (negative = back); 12 = one year. */
export const shiftMonth = (year: number, month: number, months: number) => {
  const total = year * 12 + month + months;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
};

/**
 * The 6×7 grid shown for a month, starting on `weekStartsOn` (0 = Sunday).
 * Days outside the month are included (shown dimmed) so the grid is always rectangular.
 */
export const monthGrid = (year: number, month: number, weekStartsOn = 0): { iso: IsoDate; inMonth: boolean }[] => {
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const lead = (firstWeekday - weekStartsOn + 7) % 7;
  return Array.from({ length: 42 }, (_, i) => {
    const iso = isoOf(year, month, 1 - lead + i);
    return { iso, inMonth: parseIso(iso).month === month };
  });
};

/**
 * Range picking: 1st click = start, 2nd = end, a 3rd click starts over.
 * A second click before the start becomes the start (the range is always ordered).
 */
export const pickRange = (range: DateRange, clicked: IsoDate): DateRange => {
  if (!range.from || range.to) return { from: clicked, to: null };
  return clicked < range.from ? { from: clicked, to: range.from } : { from: range.from, to: clicked };
};

export const inRange = (iso: IsoDate, from: IsoDate | null, to: IsoDate | null) =>
  !!from && !!to && iso >= from && iso <= to;

/** Days in an inclusive range (25/09–26/09 = 2). */
export const rangeDays = (from: IsoDate, to: IsoDate) =>
  Math.round((Date.UTC(...ymd(to)) - Date.UTC(...ymd(from))) / 86_400_000) + 1;
const ymd = (iso: IsoDate): [number, number, number] => {
  const { year, month, day } = parseIso(iso);
  return [year, month, day];
};

/** How much of the range has passed by `today` (0..1) — the filled part of the timeline pill. */
export const timelineProgress = (from: IsoDate, to: IsoDate, today: IsoDate) => {
  if (today < from) return 0;
  if (today > to) return 1;
  return rangeDays(from, today) / rangeDays(from, to);
};
