// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { DAY_STATES, HOLIDAY_SETS, HOLIDAY_SET_KEYS, type DayState, type HolidaySetKey } from './holidays';

/**
 * Calendar & working-day settings. The owner console sets the platform defaults
 * (`platform_settings.calendar`); an account (Administration → General) overrides any of them
 * (`account_settings.calendar`) — an unset account field follows the platform's, so a change of a default reaches
 * every account that never chose. The owner can lock a holiday's state; then accounts cannot change it.
 */

/** Where the Hebrew date is shown: nowhere, in calendars (pickers, calendar view, timeline axis), or also in cells. */
export const HEBREW_DATE_MODES = ['off', 'calendars', 'cells'] as const;
export type HebrewDatesMode = (typeof HEBREW_DATE_MODES)[number];

/**
 * How a span of days is counted (a timeline's duration, "+N days" in automations, a dependency lag):
 * calendar = every day; weekdays = without the weekend; workdays = without the weekend and days off.
 */
export const DURATION_MODES = ['calendar', 'weekdays', 'workdays'] as const;
export type DurationMode = (typeof DURATION_MODES)[number];

/** How a half day (an eve of a holiday) counts: half a working day, a full one, or none. */
export const HALF_DAY_MODES = ['half', 'work', 'off'] as const;
export type HalfDayMode = (typeof HALF_DAY_MODES)[number];

/** How date pickers mark days off and half days: a small dot under the day number, or nothing. */
export const PICKER_MARK_MODES = ['dot', 'none'] as const;
export type PickerMarksMode = (typeof PICKER_MARK_MODES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** An account's own day (a team day, a year-end closing): one date or a range, with a name and a state. */
export const customDaySchema = z.object({
  date: isoDate,
  /** Last day of a range (inclusive); unset = one day. */
  to: isoDate.optional(),
  name: z.string().trim().min(1).max(80),
  state: z.enum(['off', 'half', 'work']).default('off'),
});
export type CustomDay = z.infer<typeof customDaySchema>;

/** Owner console → Calendar & holidays (`platform_settings.calendar`). */
export const platformCalendarSchema = z.object({
  holiday_set: z.enum(HOLIDAY_SET_KEYS as [HolidaySetKey, ...HolidaySetKey[]]).default('israel'),
  hebrew_dates: z.enum(HEBREW_DATE_MODES).default('off'),
  duration: z.enum(DURATION_MODES).default('calendar'),
  half_day: z.enum(HALF_DAY_MODES).default('half'),
  picker_marks: z.enum(PICKER_MARK_MODES).default('dot'),
  /** Per holiday key: a default state other than the set's, and whether accounts may change it (default yes). */
  holidays: z
    .record(z.string().max(60), z.object({ state: z.enum(DAY_STATES).optional(), locked: z.boolean().optional() }))
    .default({}),
});
export type PlatformCalendarSettings = z.infer<typeof platformCalendarSchema>;

/** Administration → General → Calendar & working days (`account_settings.calendar`); unset = the platform's. */
export const accountCalendarSchema = z.object({
  holiday_set: z.enum(HOLIDAY_SET_KEYS as [HolidaySetKey, ...HolidaySetKey[]]).optional(),
  hebrew_dates: z.enum(HEBREW_DATE_MODES).optional(),
  duration: z.enum(DURATION_MODES).optional(),
  half_day: z.enum(HALF_DAY_MODES).optional(),
  picker_marks: z.enum(PICKER_MARK_MODES).optional(),
  /** The account's state per holiday key (unset = the platform's). */
  holidays: z.record(z.string().max(60), z.enum(DAY_STATES)).default({}),
  custom_days: z.array(customDaySchema).max(500).default([]),
});
export type AccountCalendarSettings = z.infer<typeof accountCalendarSchema>;

/** The calendar an account works by: everything resolved (sent to the web, used by the server). */
export const calendarConfigSchema = z.object({
  holiday_set: z.enum(HOLIDAY_SET_KEYS as [HolidaySetKey, ...HolidaySetKey[]]),
  hebrew_dates: z.enum(HEBREW_DATE_MODES),
  duration: z.enum(DURATION_MODES),
  half_day: z.enum(HALF_DAY_MODES),
  picker_marks: z.enum(PICKER_MARK_MODES),
  /** The state of every holiday of the set. */
  holidays: z.record(z.string(), z.enum(DAY_STATES)),
  /** Which holidays the owner locked (accounts see them read-only). */
  locked: z.array(z.string()),
  custom_days: z.array(customDaySchema),
});
export type CalendarConfig = {
  holiday_set: HolidaySetKey;
  hebrew_dates: HebrewDatesMode;
  duration: DurationMode;
  half_day: HalfDayMode;
  picker_marks: PickerMarksMode;
  holidays: Record<string, DayState>;
  locked: string[];
  custom_days: CustomDay[];
};

/**
 * The account's calendar from the platform defaults and the account's own choices (either may be missing or
 * invalid — then the built-in defaults apply).
 */
export const resolveCalendar = (platform?: unknown, account?: unknown): CalendarConfig => {
  const p = platformCalendarSchema.safeParse(platform ?? {});
  const pd = p.success ? p.data : platformCalendarSchema.parse({});
  const a = accountCalendarSchema.safeParse(account ?? {});
  const ad = a.success ? a.data : accountCalendarSchema.parse({});
  const set = ad.holiday_set ?? pd.holiday_set;
  const holidays: Record<string, DayState> = {};
  const locked: string[] = [];
  for (const def of HOLIDAY_SETS[set] ?? []) {
    const own = pd.holidays[def.key];
    const platformState = own?.state ?? def.state;
    if (own?.locked) locked.push(def.key);
    holidays[def.key] = own?.locked ? platformState : (ad.holidays[def.key] ?? platformState);
  }
  return {
    holiday_set: set,
    hebrew_dates: ad.hebrew_dates ?? pd.hebrew_dates,
    duration: ad.duration ?? pd.duration,
    half_day: ad.half_day ?? pd.half_day,
    picker_marks: ad.picker_marks ?? pd.picker_marks,
    holidays,
    locked,
    custom_days: ad.custom_days,
  };
};

/** The calendar with nothing set anywhere (Israeli holidays, no Hebrew dates, calendar days). */
export const DEFAULT_CALENDAR: CalendarConfig = resolveCalendar();
