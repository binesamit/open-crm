// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type DayState,
  dayMarkName,
  DURATION_MODES,
  HALF_DAY_MODES,
  HEBREW_DATE_MODES,
  HOLIDAY_SET_KEYS,
  HOLIDAY_SETS,
  type HolidaySetKey,
  PICKER_MARK_MODES,
  type PlatformCalendarSettings,
  type PlatformSettingsResponse,
  t,
  type UpdatePlatformSettings,
} from '@bines/shared';
import { Card, DayStateMenu, Field, Notice, Picker, Segmented, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';

type CalendarPatch = NonNullable<UpdatePlatformSettings['calendar']>;

/**
 * Owner console → General → Calendar & holidays (canvas board ו): the defaults every account follows
 * until it chooses its own — the holiday set, Hebrew dates, how durations and half days count, and each holiday's
 * default state with whether accounts may change it (`locked` = they may not). Every control saves on its own.
 */
export const PlatformCalendarCard = ({ data }: { data: PlatformSettingsResponse }) => {
  const qc = useQueryClient();
  const cal: PlatformCalendarSettings = data.settings.calendar;
  const save = useMutation({
    mutationFn: (calendar: CalendarPatch) => api().patch<PlatformSettingsResponse>('/platform/settings', { calendar }),
    onSuccess: (res) => {
      qc.setQueryData(['platform', 'settings'], res);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const holidays = HOLIDAY_SETS[cal.holiday_set] ?? [];
  /** One holiday's entry changed; an entry equal to the set's default (and unlocked) is not stored. */
  const setHoliday = (key: string, setDefault: DayState, change: { state?: DayState; locked?: boolean }) => {
    const current = cal.holidays[key] ?? {};
    const merged = { ...current, ...change };
    const entry = {
      ...(merged.state && merged.state !== setDefault ? { state: merged.state } : {}),
      ...(merged.locked ? { locked: true } : {}),
    };
    const next = { ...cal.holidays };
    if (Object.keys(entry).length) next[key] = entry;
    else delete next[key];
    save.mutate({ holidays: next });
  };
  return (
    <Card className="space-y-3" data-testid="owner-calendar">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-fg">{t('owner.calendar.title')}</h3>
        <p className="text-xs text-muted">{t('owner.calendar.hint')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('admin.calendar.holidaySet')}>
          <Picker<HolidaySetKey>
            label={t('admin.calendar.holidaySet')}
            testId="owner-calendar-holiday-set"
            value={cal.holiday_set}
            onChange={(holiday_set) => save.mutate({ holiday_set })}
            options={HOLIDAY_SET_KEYS.map((k) => ({ value: k, label: t(`holidaySet.${k}`) }))}
          />
        </Field>
        <Field label={t('admin.calendar.hebrewDates')}>
          <Segmented
            label={t('admin.calendar.hebrewDates')}
            value={cal.hebrew_dates}
            onChange={(hebrew_dates) => save.mutate({ hebrew_dates })}
            options={HEBREW_DATE_MODES.map((m) => ({
              value: m,
              label: t(`hebrewDates.${m}`),
              testId: `owner-calendar-hebrew-${m}`,
            }))}
          />
        </Field>
        <Field label={t('admin.calendar.pickerMarks')}>
          <Segmented
            label={t('admin.calendar.pickerMarks')}
            value={cal.picker_marks}
            onChange={(picker_marks) => save.mutate({ picker_marks })}
            options={PICKER_MARK_MODES.map((m) => ({
              value: m,
              label: t(`pickerMarks.${m}`),
              testId: `owner-calendar-picker-marks-${m}`,
            }))}
          />
        </Field>
        <Field label={t('admin.calendar.duration')} hint={t('admin.calendar.durationHint')}>
          <Picker<(typeof DURATION_MODES)[number]>
            label={t('admin.calendar.duration')}
            testId="owner-calendar-duration"
            value={cal.duration}
            onChange={(duration) => save.mutate({ duration })}
            options={DURATION_MODES.map((m) => ({ value: m, label: t(`duration.${m}`) }))}
          />
        </Field>
        <Field label={t('admin.calendar.halfDay')}>
          <Picker<(typeof HALF_DAY_MODES)[number]>
            label={t('admin.calendar.halfDay')}
            testId="owner-calendar-half-day"
            value={cal.half_day}
            onChange={(half_day) => save.mutate({ half_day })}
            options={HALF_DAY_MODES.map((m) => ({ value: m, label: t(`halfDay.${m}`) }))}
          />
        </Field>
      </div>
      <div className="space-y-1.5" data-testid="owner-calendar-holidays">
        <div className="space-y-0.5">
          <div className="text-sm font-semibold text-fg">{t('admin.calendar.holidays')}</div>
          <p className="text-xs text-muted">{t('owner.calendar.holidaysHint')}</p>
        </div>
        {holidays.length ? (
          <table className="w-full text-sm font-normal">
            <thead>
              <tr className="text-xs text-muted">
                <th className="py-1.5 text-start font-normal">{t('admin.calendar.holiday')}</th>
                <th className="py-1.5 text-start font-normal">{t('owner.calendar.defaultState')}</th>
                <th className="py-1.5 text-start font-normal">{t('owner.calendar.accountsMayChange')}</th>
              </tr>
            </thead>
            <tbody>
              {holidays.map((h) => {
                const own = cal.holidays[h.key];
                const name = dayMarkName({ key: h.key, state: 'off' });
                return (
                  <tr
                    key={h.key}
                    className="border-t border-line-soft"
                    data-testid="owner-calendar-holiday"
                    data-key={h.key}
                  >
                    <td className="py-1.5 pe-2 text-fg">{name}</td>
                    <td className="py-1.5 pe-2">
                      <DayStateMenu
                        label={name}
                        testId={`owner-calendar-holiday-${h.key}`}
                        value={own?.state ?? h.state}
                        disabled={save.isPending}
                        onChange={(state) => setHoliday(h.key, h.state, { state })}
                      />
                    </td>
                    <td className="py-1.5">
                      <Switch
                        checked={!own?.locked}
                        disabled={save.isPending}
                        label={`${t('owner.calendar.accountsMayChange')} · ${name}`}
                        testId={`owner-calendar-holiday-open-${h.key}`}
                        onChange={(open) => setHoliday(h.key, h.state, { locked: !open })}
                      />
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
      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
    </Card>
  );
};
