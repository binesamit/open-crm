// SPDX-License-Identifier: AGPL-3.0-only
import { getLocale, intlLocale, isLocale, type Locale } from '../i18n';
import { parseIso, type IsoDate } from '../calendar';
import { dateInZone, isWeekend } from '../query/dates';
import { DEFAULT_CALENDAR, type CalendarConfig } from '../workdays/settings';

/**
 * Region settings applied everywhere (A3 — 08 §2 `locale.*`, ANSWERS §6 #6): the one place that turns dates,
 * times and numbers into text. The account sets the defaults (Administration → כללי); a member's profile may
 * override the language and the timezone. The web app keeps the signed-in member's region as the runtime region
 * (`setRegion`, like `setLocale` for texts), so components call these helpers without passing it; the server
 * never sets it and always passes the region of the account / reader explicitly.
 */
export type Weekend = 'fri_sat' | 'sat_sun';
export type TimeFormat = '24h' | '12h';

export type Region = {
  language: Locale;
  /** IANA zone; instants (created_at, a date column's time) are shown in it. */
  timezone: string;
  /** 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD.MM.YYYY' (DATE_FORMATS); other patterns of DD/MM/YYYY/YY work too. */
  date_format: string;
  time_format: TimeFormat;
  /** 0 = Sunday … 6 = Saturday. */
  first_day: number;
  weekend: Weekend;
  /** ISO 4217 code for money (number columns shown as currency, automation variables). */
  currency: string;
  /** Hebrew dates, holidays and working days: the account's calendar, resolved. */
  calendar: CalendarConfig;
};

export const DEFAULT_REGION: Region = {
  language: 'he',
  timezone: 'Asia/Jerusalem',
  date_format: 'DD/MM/YYYY',
  time_format: '24h',
  first_day: 0,
  weekend: 'fri_sat',
  currency: 'ILS',
  calendar: DEFAULT_CALENDAR,
};

const zoneOk = new Map<string, boolean>();
/** Whether the runtime knows an IANA zone (an unknown one would throw in every Intl call). */
export const isValidTimeZone = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz) return false;
  let ok = zoneOk.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    zoneOk.set(tz, ok);
  }
  return ok;
};

type AccountLocale = Partial<{
  language: string;
  timezone: string;
  date_format: string;
  time_format: string;
  first_day: number;
  weekend: string;
  currency: string;
}>;

/**
 * The region a person sees: the account's `settings.locale`, then the member's own language and timezone (the
 * profile has only these two — 08 §12.1). A member who never chose a timezone (`users.timezone` null) follows the
 * account's — so an admin's change reaches them; anything missing or invalid falls back to the defaults.
 */
export const resolveRegion = (
  account?: AccountLocale | null,
  user?: { locale?: string | null; timezone?: string | null } | null,
  /** The account's resolved calendar (`resolveCalendar`); unset = the built-in defaults. */
  calendar?: CalendarConfig | null,
): Region => {
  const a = account ?? {};
  const pick = <T>(v: unknown, ok: (x: unknown) => x is T, fallback: T): T => (ok(v) ? v : fallback);
  const language = pick(user?.locale, isLocale, pick(a.language, isLocale, DEFAULT_REGION.language));
  const timezone = pick(user?.timezone, isValidTimeZone, pick(a.timezone, isValidTimeZone, DEFAULT_REGION.timezone));
  return {
    language,
    timezone,
    date_format:
      typeof a.date_format === 'string' && /D/.test(a.date_format) ? a.date_format : DEFAULT_REGION.date_format,
    time_format: a.time_format === '12h' ? '12h' : '24h',
    first_day:
      Number.isInteger(a.first_day) && a.first_day! >= 0 && a.first_day! <= 6 ? a.first_day! : DEFAULT_REGION.first_day,
    weekend: a.weekend === 'sat_sun' ? 'sat_sun' : 'fri_sat',
    currency: typeof a.currency === 'string' && /^[A-Z]{3}$/.test(a.currency) ? a.currency : DEFAULT_REGION.currency,
    calendar: calendar ?? DEFAULT_CALENDAR,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// The runtime region (web). The language always follows the UI language (`getLocale`).
// ---------------------------------------------------------------------------------------------------------------
let stored: Region = DEFAULT_REGION;
let cached: Region | null = null;
const listeners = new Set<() => void>();

/** A stable key of everything but the language — the web re-mounts when it changes (like a language switch). */
export const regionKey = (r: Region) =>
  [r.timezone, r.date_format, r.time_format, r.first_day, r.weekend, r.currency, JSON.stringify(r.calendar)].join('|');

export const getRegion = (): Region => {
  const language = getLocale();
  if (!cached || cached.language !== language) cached = { ...stored, language };
  return cached;
};

export const setRegion = (region: Region) => {
  if (regionKey(region) === regionKey(stored)) return;
  stored = region;
  cached = null;
  for (const fn of listeners) fn();
};

/** For `useSyncExternalStore(subscribeRegion, getRegion)`. */
export const subscribeRegion = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Intl helpers (formatters are cached: a board formats thousands of dates).
// ---------------------------------------------------------------------------------------------------------------
const dtfCache = new Map<string, Intl.DateTimeFormat>();
const dtf = (lang: string, opts: Intl.DateTimeFormatOptions) => {
  const key = `${lang}|${JSON.stringify(opts)}`;
  let f = dtfCache.get(key);
  if (!f) dtfCache.set(key, (f = new Intl.DateTimeFormat(lang, opts)));
  return f;
};
const nfCache = new Map<string, Intl.NumberFormat>();
const nf = (lang: string, opts: Intl.NumberFormatOptions) => {
  const key = `${lang}|${JSON.stringify(opts)}`;
  let f = nfCache.get(key);
  if (!f) nfCache.set(key, (f = new Intl.NumberFormat(lang, opts)));
  return f;
};

const zone = (r: Region) => (isValidTimeZone(r.timezone) ? r.timezone : DEFAULT_REGION.timezone);
const toDate = (instant: Date | string | number) => (instant instanceof Date ? instant : new Date(instant));
const utcMs = (iso: IsoDate) => {
  const { year, month, day } = parseIso(iso);
  return Date.UTC(year, month, day);
};

/** "Today" in the region's timezone. */
export const todayIn = (r: Region = getRegion(), now: Date = new Date()): IsoDate => dateInZone(now, zone(r));

/** The calendar date of an instant in the region's timezone (DST-safe: Intl does the zone math). */
export const localDateOf = (instant: Date | string | number, r: Region = getRegion()): IsoDate =>
  dateInZone(toDate(instant), zone(r));

// ---------------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------------
export type YearMode = 'always' | 'auto' | 'short' | 'never';
export type DateOpts = {
  /** always (default) · auto = only outside the current year · short = two digits · never. */
  year?: YearMode;
  /** For `year: 'auto'`; default = today in the region. */
  today?: IsoDate;
  /** Adds the weekday name before the date. */
  weekday?: 'short' | 'long';
};

const patternCache = new Map<string, string[]>();
const patternTokens = (pattern: string): string[] => {
  let toks = patternCache.get(pattern);
  if (!toks) patternCache.set(pattern, (toks = pattern.match(/YYYY|YY|MM|DD|[^YMD]+/g) ?? ['DD', '/', 'MM']));
  return toks;
};
const isYear = (tok: string) => tok === 'YYYY' || tok === 'YY';

/** A pattern without its year part (and the separator next to it): DD/MM/YYYY → DD/MM, YYYY-MM-DD → MM-DD. */
const withoutYear = (toks: string[]): string[] => {
  const i = toks.findIndex(isYear);
  if (i < 0) return toks;
  const out = [...toks];
  const sep = (j: number) => j >= 0 && j < out.length && !/^(YYYY|YY|MM|DD)$/.test(out[j]!);
  if (i === out.length - 1 && sep(i - 1)) out.splice(i - 1, 2);
  else if (sep(i + 1)) out.splice(i, 2);
  else out.splice(i, 1);
  return out;
};

/** A calendar date ('YYYY-MM-DD', never shifted by a zone) in the region's date format. */
export const formatDate = (iso: IsoDate, opts: DateOpts = {}, r: Region = getRegion()): string => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
  const y = iso.slice(0, 4);
  const mode = opts.year ?? 'always';
  const dropYear = mode === 'never' || (mode === 'auto' && y === (opts.today ?? todayIn(r)).slice(0, 4));
  const toks = dropYear ? withoutYear(patternTokens(r.date_format)) : patternTokens(r.date_format);
  const text = toks
    .map((tok) =>
      tok === 'YYYY'
        ? mode === 'short'
          ? y.slice(2)
          : y
        : tok === 'YY'
          ? y.slice(2)
          : tok === 'MM'
            ? iso.slice(5, 7)
            : tok === 'DD'
              ? iso.slice(8, 10)
              : tok,
    )
    .join('');
  return opts.weekday ? `${weekdayName(iso, opts.weekday, r)} ${text}` : text;
};

/** The weekday name of a calendar date ("Mon" / "יום ב׳"), in the region's language. */
export const weekdayName = (iso: IsoDate, style: 'narrow' | 'short' | 'long' = 'short', r: Region = getRegion()) =>
  dtf(intlLocale(r.language), { weekday: style, timeZone: 'UTC' }).format(utcMs(iso));

/** The 7 weekday names in display order (from the region's first day), for calendar headers. */
export const weekdayNames = (style: 'narrow' | 'short' | 'long' = 'narrow', r: Region = getRegion()): string[] =>
  // 2026-01-04 is a Sunday.
  Array.from({ length: 7 }, (_, i) =>
    dtf(intlLocale(r.language), { weekday: style, timeZone: 'UTC' }).format(
      Date.UTC(2026, 0, 4 + ((i + r.first_day) % 7)),
    ),
  );

/** "October 2026" / "אוקטובר 2026" — a calendar title (`month` 0-based). */
export const formatMonthYear = (year: number, month: number, r: Region = getRegion()) =>
  dtf(intlLocale(r.language), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(year, month, 1));

/** A month's name ("Oct" / "October"). */
export const formatMonthName = (month: number, style: 'short' | 'long' = 'short', r: Region = getRegion()) =>
  dtf(intlLocale(r.language), { month: style, timeZone: 'UTC' }).format(Date.UTC(2026, month, 1));

/** "Sunday, October 4" / "יום ראשון, 4 אוקטובר" (the month's own name in Hebrew, not "באוקטובר"). */
export const formatLongDay = (iso: IsoDate, r: Region = getRegion()): string => {
  if (r.language !== 'he')
    return dtf(intlLocale(r.language), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
      utcMs(iso),
    );
  const { month, day } = parseIso(iso);
  return `${weekdayName(iso, 'long', r)}, ${day} ${formatMonthName(month, 'long', r)}`;
};

/**
 * "5 Oct" / "5 באוק׳" — a short human date with the month's name. A plain 'YYYY-MM-DD' is a calendar date; anything
 * else is an instant shown in the region's timezone. `year`: add the year (default: only outside the current one).
 */
export const formatDayMonth = (
  value: Date | string | number,
  opts: { year?: boolean; weekday?: boolean } = {},
  r: Region = getRegion(),
): string => {
  const plain = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const iso = plain ? (value as string) : localDateOf(value, r);
  const year = opts.year ?? iso.slice(0, 4) !== todayIn(r).slice(0, 4);
  const f = dtf(intlLocale(r.language), {
    day: 'numeric',
    month: 'short',
    ...(year ? { year: 'numeric' } : {}),
    ...(opts.weekday ? { weekday: 'short' } : {}),
    timeZone: 'UTC',
  });
  if (r.language !== 'he') return f.format(utcMs(iso));
  // Hebrew: "3 ספט׳" (Intl writes "3 בספט׳").
  const part = Object.fromEntries(f.formatToParts(utcMs(iso)).map((x) => [x.type, x.value])) as Record<string, string>;
  const text = `${part.day} ${(part.month ?? '').replace(/^ב/, '')}${year ? ` ${part.year}` : ''}`;
  return opts.weekday ? `${part.weekday}, ${text}` : text;
};

/** An hour of the day ("08:00" / "8:00 AM") in the region's time format — digest hours, schedules. */
export const formatHour = (hour: number, r: Region = getRegion()): string =>
  dtf(intlLocale(r.language), {
    hour: r.time_format === '12h' ? 'numeric' : '2-digit',
    minute: '2-digit',
    hourCycle: r.time_format === '12h' ? 'h12' : 'h23',
    timeZone: 'UTC',
  }).format(Date.UTC(2026, 0, 1, hour));

// ---------------------------------------------------------------------------------------------------------------
// Instants (created_at, update times, a date column's time — always stored in UTC)
// ---------------------------------------------------------------------------------------------------------------

/** The time of an instant in the region's zone: "14:05" (24h) or "2:05 PM" (12h). */
export const formatTime = (instant: Date | string | number, r: Region = getRegion()): string =>
  dtf(intlLocale(r.language), {
    hour: r.time_format === '12h' ? 'numeric' : '2-digit',
    minute: '2-digit',
    hourCycle: r.time_format === '12h' ? 'h12' : 'h23',
    timeZone: zone(r),
  }).format(toDate(instant));

/** How far the zone is ahead of UTC at an instant (ms; +3h in Jerusalem's summer). */
const zoneOffsetMs = (ms: number, timeZone: string) => {
  const p = Object.fromEntries(
    dtf('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(ms)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!);
  return wall - Math.floor(ms / 1000) * 1000;
};

/**
 * The instant of a wall-clock time on a calendar date in the region's zone ('2026-10-05' + '14:30' in Jerusalem →
 * 11:30Z). DST: a time skipped by the spring jump lands after it; an hour repeated in autumn takes the first one.
 */
export const zonedInstant = (iso: IsoDate, hm: string, r: Region = getRegion()): Date => {
  const { year, month, day } = parseIso(iso);
  const [h = 0, m = 0] = hm.split(':').map(Number);
  const wall = Date.UTC(year, month, day, h, m);
  const tz = zone(r);
  // The zone's offsets half a day before and after: around a DST change they differ.
  const before = zoneOffsetMs(wall - 43_200_000, tz);
  const after = zoneOffsetMs(wall + 43_200_000, tz);
  const fits = [wall - before, wall - after].filter((t) => t + zoneOffsetMs(t, tz) === wall);
  // Autumn: both fit (the repeated hour) — the earlier one. Spring gap: none fits — the old offset, after the jump.
  return new Date(fits.length ? Math.min(...fits) : wall - before);
};

/** 'HH:MM' (24h, for machine-like patterns) of an instant in the region's zone. */
export const localTimeOf = (instant: Date | string | number, r: Region = getRegion()): string =>
  dtf('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone(r) }).format(toDate(instant));

/** The local date of an instant, in the region's date format. */
export const formatInstantDate = (instant: Date | string | number, opts: DateOpts = {}, r: Region = getRegion()) =>
  formatDate(localDateOf(instant, r), opts, r);

/** Date and time of an instant: "05/10/2026 14:05". */
export const formatDateTime = (instant: Date | string | number, opts: DateOpts = {}, r: Region = getRegion()) =>
  `${formatInstantDate(instant, opts, r)} ${formatTime(instant, r)}`;

/**
 * A date column's value (03 §2.7): a calendar date, optionally with a UTC time — then the instant is shown in the
 * region's zone (the day may move). `settings`: the column's display options.
 */
export const formatDateValue = (
  v: { date: IsoDate; time?: string },
  r: Region = getRegion(),
  settings: { show_weekday?: boolean; hide_current_year?: boolean } = {},
): string => {
  const opts: DateOpts = {
    ...(settings.hide_current_year ? { year: 'auto' } : {}),
    ...(settings.show_weekday ? { weekday: 'short' } : {}),
  };
  if (!v.time) return formatDate(v.date, opts, r);
  const at = new Date(`${v.date}T${v.time.length === 5 ? `${v.time}:00` : v.time}Z`);
  if (Number.isNaN(at.getTime())) return formatDate(v.date, opts, r);
  const local = localDateOf(at, r);
  return `${formatDate(local, opts, r)} ${formatTime(at, r)}`;
};

/**
 * A date column's value as the region sees it: its local calendar date and wall-clock "HH:MM"
 * when it has a time (the stored time is UTC, 03 §2.7). A plain date is never shifted.
 */
export const localDateValue = (
  v: { date: IsoDate; time?: string },
  r: Region = getRegion(),
): { date: IsoDate; time?: string } => {
  if (!v.time) return { date: v.date };
  const at = new Date(`${v.date}T${v.time.length === 5 ? `${v.time}:00` : v.time}Z`);
  if (Number.isNaN(at.getTime())) return { date: v.date };
  return { date: localDateOf(at, r), time: localTimeOf(at, r) };
};

/** The value stored for a local date and an optional wall-clock "HH:MM" in the region's zone (the time as UTC). */
export const storedDateValue = (
  date: IsoDate,
  time?: string | null,
  r: Region = getRegion(),
): { date: IsoDate; time?: string } => {
  if (!time) return { date };
  const iso = zonedInstant(date, time, r).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
};

/**
 * Timeline label (03 §2.8): day and month in the region's order; the year (two digits) only when the range crosses
 * into another year or lies outside the current one. One day = one date.
 */
export const formatTimeline = (from: IsoDate, to: IsoDate, today: IsoDate = todayIn(), r: Region = getRegion()) => {
  const year = (iso: IsoDate) => iso.slice(0, 4);
  const withYear = year(from) !== year(to) || year(from) !== year(today);
  const one = (iso: IsoDate) => formatDate(iso, { year: withYear ? 'short' : 'never' }, r);
  return from === to ? one(from) : `${one(from)} – ${one(to)}`;
};

/** A date range "05/10/2026 – 08/10/2026" (one date when both ends are the same day). */
export const formatDateRange = (from: IsoDate, to: IsoDate | null, opts: DateOpts = {}, r: Region = getRegion()) =>
  !to || from === to ? formatDate(from, opts, r) : `${formatDate(from, opts, r)} – ${formatDate(to, opts, r)}`;

// ---------------------------------------------------------------------------------------------------------------
// Week
// ---------------------------------------------------------------------------------------------------------------

/** The region's weekend weekdays (0 = Sunday): fri_sat → [5, 6], sat_sun → [6, 0]. */
export const weekendDays = (r: Region = getRegion()): number[] => (r.weekend === 'sat_sun' ? [6, 0] : [5, 6]);

/** Whether a calendar date falls on the region's weekend (calendar shading, workday math). */
export const isWeekendDate = (iso: IsoDate, r: Region = getRegion()) => isWeekend(iso, r.weekend);

// ---------------------------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------------------------

/** A number with the region language's grouping ("12,345.5"). */
export const formatNumber = (n: number, opts: Intl.NumberFormatOptions = {}, r: Region = getRegion()) =>
  nf(intlLocale(r.language), opts).format(n);

/** Money in the region's currency (or `code`): "‏1,234.50 ₪" / "$1,234.50". An unknown code falls back to a number. */
export const formatCurrency = (n: number, code?: string | null, r: Region = getRegion()) => {
  try {
    return nf(intlLocale(r.language), { style: 'currency', currency: code || r.currency }).format(n);
  } catch {
    return `${formatNumber(n, {}, r)} ${code || r.currency}`;
  }
};
