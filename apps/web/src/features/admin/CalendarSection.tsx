// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  type AccountDetail,
  type CustomDay,
  type DayState,
  DURATION_MODES,
  HALF_DAY_MODES,
  HEBREW_DATE_MODES,
  HOLIDAY_SET_KEYS,
  HOLIDAY_SETS,
  holidaysOfYear,
  PICKER_MARK_MODES,
  type HolidaySetKey,
  type IsoDate,
  dayMarkName,
  platformCalendarSchema,
  resolveCalendar,
  t,
  todayIn,
  type UpdateAccount,
} from '@bines/shared';
import { Button, Calendar, cn, DayStateMenu, DayStatePill, formatIsoDate, Input, Picker, Segmented } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { Popover } from '../board/cells/Popover';
import { Panel, Row } from './admin-parts';

type Patch = NonNullable<UpdateAccount['settings']>;
type CalendarPatch = NonNullable<Patch['calendar']>;

/** The value a Picker uses for "follow the platform" (never a real setting value). */
const PLATFORM = '__platform';

/** The next date (from today) a holiday of a set falls on, or null. */
export const nextHolidayDate = (set: HolidaySetKey, key: string, today: IsoDate): IsoDate | null => {
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    for (const [iso, keys] of holidaysOfYear(set, y)) if (iso >= today && keys.includes(key)) return iso;
  }
  return null;
};

/** "24/12/2026" or "24/12/2026 – 26/12/2026". */
const spanText = (from: IsoDate, to?: IsoDate | null) =>
  to && to > from ? `${formatIsoDate(from)} – ${formatIsoDate(to)}` : formatIsoDate(from);

/**
 * Administration → General → Calendar & working days (canvas board ה): Hebrew dates, how durations
 * count, how a half day counts, the holiday set and each holiday's state, and the account's own days. A field the
 * account never set follows the owner's default (shown under it); a holiday the owner locked is read-only.
 */
export const CalendarSection = ({
  detail,
  busy,
  onSave,
}: {
  detail: AccountDetail;
  busy: boolean;
  onSave: (s: Patch, done?: () => void) => void;
}) => {
  const own = detail.settings.calendar;
  const platform = detail.platform_defaults?.calendar ?? platformCalendarSchema.parse({});
  const resolved = detail.calendar ?? resolveCalendar(platform, own);
  const base = resolveCalendar(platform, { holiday_set: resolved.holiday_set });
  const save = (calendar: CalendarPatch, done?: () => void) => onSave({ calendar }, done);
  const [today] = useState(() => todayIn());
  const defaultHint = (value: string) => t('admin.calendar.platformDefault', { value });
  const reset = (field: 'hebrew_dates' | 'picker_marks' | 'duration' | 'half_day' | 'holiday_set', testId: string) => (
    <button
      type="button"
      disabled={busy}
      onClick={() => save({ [field]: null })}
      className="text-xs text-heading underline underline-offset-2 hover:no-underline"
      data-testid={testId}
    >
      {t('admin.calendar.backToPlatform')}
    </button>
  );
  const holidays = HOLIDAY_SETS[resolved.holiday_set] ?? [];
  const locked = new Set(resolved.locked);
  const setHoliday = (key: string, state: DayState | typeof PLATFORM) => {
    const next = { ...own.holidays };
    if (state === PLATFORM) delete next[key];
    else next[key] = state;
    save({ holidays: next });
  };
  return (
    <Panel title={t('admin.calendar.title')} hint={t('admin.calendar.hint')} testId="admin-general-calendar">
      <Row
        label={t('admin.calendar.hebrewDates')}
        hint={own.hebrew_dates ? undefined : defaultHint(t(`hebrewDates.${platform.hebrew_dates}`))}
        below={own.hebrew_dates ? reset('hebrew_dates', 'admin-calendar-hebrew-reset') : null}
      >
        <Segmented
          label={t('admin.calendar.hebrewDates')}
          value={resolved.hebrew_dates}
          onChange={(hebrew_dates) => save({ hebrew_dates })}
          options={HEBREW_DATE_MODES.map((m) => ({
            value: m,
            label: t(`hebrewDates.${m}`),
            testId: `admin-calendar-hebrew-${m}`,
          }))}
        />
      </Row>
      <Row
        label={t('admin.calendar.pickerMarks')}
        hint={own.picker_marks ? undefined : defaultHint(t(`pickerMarks.${platform.picker_marks}`))}
        below={own.picker_marks ? reset('picker_marks', 'admin-calendar-picker-marks-reset') : null}
      >
        <Segmented
          label={t('admin.calendar.pickerMarks')}
          value={resolved.picker_marks}
          onChange={(picker_marks) => save({ picker_marks })}
          options={PICKER_MARK_MODES.map((m) => ({
            value: m,
            label: t(`pickerMarks.${m}`),
            testId: `admin-calendar-picker-marks-${m}`,
          }))}
        />
      </Row>
      <Row
        label={t('admin.calendar.duration')}
        hint={
          own.duration
            ? t('admin.calendar.durationHint')
            : `${t('admin.calendar.durationHint')} ${defaultHint(t(`duration.${platform.duration}`))}`
        }
      >
        <Picker<string>
          label={t('admin.calendar.duration')}
          testId="admin-calendar-duration"
          className="w-72"
          value={own.duration ?? PLATFORM}
          onChange={(v) => save({ duration: v === PLATFORM ? null : (v as (typeof DURATION_MODES)[number]) })}
          options={[
            {
              value: PLATFORM,
              label: t('admin.calendar.followPlatform', { value: t(`duration.${platform.duration}`) }),
            },
            ...DURATION_MODES.map((m) => ({ value: m, label: t(`duration.${m}`) })),
          ]}
        />
      </Row>
      <Row
        label={t('admin.calendar.halfDay')}
        hint={own.half_day ? undefined : defaultHint(t(`halfDay.${platform.half_day}`))}
      >
        <Picker<string>
          label={t('admin.calendar.halfDay')}
          testId="admin-calendar-half-day"
          className="w-56"
          value={own.half_day ?? PLATFORM}
          onChange={(v) => save({ half_day: v === PLATFORM ? null : (v as (typeof HALF_DAY_MODES)[number]) })}
          options={[
            {
              value: PLATFORM,
              label: t('admin.calendar.followPlatform', { value: t(`halfDay.${platform.half_day}`) }),
            },
            ...HALF_DAY_MODES.map((m) => ({ value: m, label: t(`halfDay.${m}`) })),
          ]}
        />
      </Row>
      <Row
        label={t('admin.calendar.holidaySet')}
        hint={own.holiday_set ? undefined : defaultHint(t(`holidaySet.${platform.holiday_set}`))}
      >
        <Picker<string>
          label={t('admin.calendar.holidaySet')}
          testId="admin-calendar-holiday-set"
          className="w-56"
          value={own.holiday_set ?? PLATFORM}
          onChange={(v) => save({ holiday_set: v === PLATFORM ? null : (v as HolidaySetKey) })}
          options={[
            {
              value: PLATFORM,
              label: t('admin.calendar.followPlatform', { value: t(`holidaySet.${platform.holiday_set}`) }),
            },
            ...HOLIDAY_SET_KEYS.map((k) => ({ value: k, label: t(`holidaySet.${k}`) })),
          ]}
        />
      </Row>
      <div className="border-b border-line-soft px-3.5 py-3" data-testid="admin-calendar-holidays">
        <div className="mb-2 space-y-0.5">
          <div className="text-sm font-semibold text-fg">{t('admin.calendar.holidays')}</div>
          <p className="text-xs text-muted">{t('admin.calendar.holidaysHint')}</p>
        </div>
        {holidays.length ? (
          <table className="w-full text-sm font-normal">
            <thead>
              <tr className="text-start text-xs text-muted">
                <th className="py-1.5 text-start font-normal">{t('admin.calendar.holiday')}</th>
                <th className="py-1.5 text-start font-normal max-sm:hidden">{t('admin.calendar.nextDate')}</th>
                <th className="py-1.5 text-start font-normal">{t('admin.calendar.state')}</th>
                <th className="py-1.5 text-start font-normal">{t('admin.calendar.source')}</th>
              </tr>
            </thead>
            <tbody>
              {holidays.map((h) => {
                const next = nextHolidayDate(resolved.holiday_set, h.key, today);
                const isLocked = locked.has(h.key);
                const platformState = base.holidays[h.key] ?? h.state;
                const state = resolved.holidays[h.key] ?? platformState;
                return (
                  <tr
                    key={h.key}
                    className="border-t border-line-soft"
                    data-testid="admin-calendar-holiday"
                    data-key={h.key}
                    data-state={state}
                  >
                    <td className="py-1.5 pe-2 text-fg">{dayMarkName({ key: h.key, state: 'off' })}</td>
                    <td className="py-1.5 pe-2 text-muted max-sm:hidden">{next ? formatIsoDate(next) : '—'}</td>
                    <td className="py-1.5 pe-2">
                      {isLocked ? (
                        <span
                          className="inline-flex items-center gap-1.5"
                          title={t('admin.calendar.locked')}
                          data-testid="admin-calendar-holiday-locked"
                        >
                          <DayStatePill state={state} />
                          <Icon name="lock" size={13} className="text-muted" />
                          <span className="sr-only">{t('admin.calendar.locked')}</span>
                        </span>
                      ) : (
                        <DayStateMenu
                          label={dayMarkName({ key: h.key, state: 'off' })}
                          testId={`admin-calendar-holiday-${h.key}`}
                          value={state}
                          disabled={busy}
                          onChange={(v) => setHoliday(h.key, v === platformState ? PLATFORM : v)}
                        />
                      )}
                    </td>
                    <td className="py-1.5 text-xs text-muted" data-testid="admin-calendar-holiday-source">
                      {isLocked ? (
                        t('admin.calendar.sourceLocked')
                      ) : own.holidays[h.key] ? (
                        <span className="inline-flex flex-wrap items-center gap-x-2">
                          {t('admin.calendar.sourceAccount')}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setHoliday(h.key, PLATFORM)}
                            className="text-heading underline underline-offset-2 hover:no-underline"
                            data-testid={`admin-calendar-holiday-${h.key}-reset`}
                          >
                            {t('admin.calendar.backToPlatform')}
                          </button>
                        </span>
                      ) : (
                        t('admin.calendar.sourcePlatform')
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-muted">{t('admin.calendar.noHolidays')}</p>
        )}
      </div>
      <CustomDays
        days={own.custom_days}
        busy={busy}
        firstDay={detail.settings.locale.first_day}
        onSave={(custom_days, done) => save({ custom_days }, done)}
      />
    </Panel>
  );
};

/** The account's own days (a team day, a year-end closing): one date or a range, a name and a state. */
const CustomDays = ({
  days,
  busy,
  firstDay,
  onSave,
}: {
  days: CustomDay[];
  busy: boolean;
  firstDay: AccountDetail['settings']['locale']['first_day'];
  onSave: (days: CustomDay[], done?: () => void) => void;
}) => {
  const [name, setName] = useState('');
  const [range, setRange] = useState<{ from: IsoDate | null; to: IsoDate | null }>({ from: null, to: null });
  const [state, setState] = useState<CustomDay['state']>('off');
  const [open, setOpen] = useState(false);
  const can = !!name.trim() && !!range.from && !busy;
  const add = () => {
    if (!can || !range.from) return;
    const day: CustomDay = {
      date: range.from,
      ...(range.to && range.to > range.from ? { to: range.to } : {}),
      name: name.trim(),
      state,
    };
    onSave([...days, day], () => {
      setName('');
      setRange({ from: null, to: null });
      setState('off');
    });
  };
  const states = (['off', 'half', 'work'] as const).map((s) => ({ value: s, label: t(`dayState.${s}`) }));
  return (
    <div className="px-3.5 py-3" data-testid="admin-calendar-custom-days">
      <div className="mb-2 space-y-0.5">
        <div className="text-sm font-semibold text-fg">{t('admin.calendar.customDays')}</div>
        <p className="text-xs text-muted">{t('admin.calendar.customDaysHint')}</p>
      </div>
      {days.length ? (
        <ul className="mb-3 divide-y divide-line-soft rounded-[10px] border border-line-soft">
          {days.map((d, i) => (
            <li
              key={`${d.date}-${d.name}-${i}`}
              className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm font-normal"
              data-testid="admin-calendar-custom-day"
            >
              <span className="min-w-0 flex-1 truncate text-fg">{d.name}</span>
              <span className="text-muted">{spanText(d.date, d.to)}</span>
              <span className="text-fg-2">{t(`dayState.${d.state}`)}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onSave(days.filter((_, j) => j !== i))}
                aria-label={t('admin.calendar.removeDay')}
                title={t('admin.calendar.removeDay')}
                className="grid size-7 place-items-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-fg"
                data-testid="admin-calendar-custom-day-remove"
              >
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-xs text-muted">{t('admin.calendar.customDaysEmpty')}</p>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input
          value={name}
          maxLength={80}
          placeholder={t('admin.calendar.dayName')}
          aria-label={t('admin.calendar.dayName')}
          onChange={(e) => setName(e.target.value)}
          className="w-52 max-sm:w-full"
          data-testid="admin-calendar-day-name"
        />
        <span className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            data-testid="admin-calendar-day-date"
            className="flex h-9 min-w-44 items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 text-start text-sm text-fg hover:border-primary"
          >
            <Icon name="calendar" size={15} className="shrink-0 text-muted" />
            <span className={cn('truncate', !range.from && 'text-muted')}>
              {range.from ? spanText(range.from, range.to) : t('admin.calendar.pickDate')}
            </span>
          </button>
          <Popover open={open} onClose={() => setOpen(false)} align="end" className="p-2">
            <Calendar
              mode="range"
              weekStartsOn={firstDay}
              value={range}
              onChange={(v) => {
                setRange(v);
                if (v.from && v.to) setOpen(false);
              }}
            />
          </Popover>
        </span>
        <Picker<CustomDay['state']>
          label={t('admin.calendar.state')}
          testId="admin-calendar-day-state"
          className="w-44"
          value={state}
          onChange={setState}
          options={states}
        />
        <Button type="submit" size="sm" busy={busy} disabled={!can} data-testid="admin-calendar-day-add">
          <Icon name="plus" size={14} />
          {t('admin.calendar.addDay')}
        </Button>
      </form>
    </div>
  );
};
