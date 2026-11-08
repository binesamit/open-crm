// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  DATE_UNITS,
  parseRelativeDay,
  relativeDayValue,
  t,
  type DateToken,
  type FilterOperator,
  type MessageKey,
} from '@bines/shared';
import { Calendar, cn, formatIsoDate } from '@bines/ui';
import { Popover } from '../cells/Popover';
import { PickerButton } from './parts';

/**
 * Fix: — relative dates everywhere a date is filtered (board filter, quick filters, saved views, dashboard
 * widget filters): today, yesterday, this / last / next week, month, quarter, year, overdue, N days ago / ahead, or an
 * exact day. Values are stored relative (tokens) so a saved view keeps meaning "this week"; the shared engine
 * resolves them in the account's timezone and first day of the week (query/dates.ts).
 */
const inputClass =
  'h-9 rounded-[10px] border border-line-strong bg-surface px-2.5 text-sm outline-none focus:border-heading';

/** The token choices, in reading order (pairs: past / future around "now"). */
export const DATE_TOKEN_CHOICES: DateToken[] = [
  'TODAY',
  'OVERDUE',
  'YESTERDAY',
  'TOMORROW',
  'THIS_WEEK',
  'LAST_WEEK',
  'NEXT_WEEK',
  'THIS_MONTH',
  'LAST_MONTH',
  'NEXT_MONTH',
  'THIS_QUARTER',
  'LAST_QUARTER',
  'NEXT_QUARTER',
  'THIS_YEAR',
  'LAST_YEAR',
  'NEXT_YEAR',
  'PAST',
  'FUTURE',
];

/** The words of one stored date value: a token, N days ago / ahead, or a fixed day. Undefined = none. */
export const dateValueLabel = (v: unknown): string | undefined => {
  if (typeof v !== 'string' || !v) return undefined;
  const rel = parseRelativeDay(v);
  if (rel)
    return rel.n === 0
      ? t('filter.date.TODAY')
      : t((rel.dir === 'ago' ? 'filter.date.daysAgo' : 'filter.date.daysAhead') as MessageKey, { n: rel.n });
  const exact = v.startsWith('EXACT:') ? v.slice(6) : /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  return exact ? formatIsoDate(exact) : t(`filter.date.${v}` as MessageKey);
};

/** One date value: a relative choice or an exact day from the system calendar (never a native picker). */
export const DateValue = ({
  value,
  onChange,
  firstDay,
  testId = 'rule-date',
}: {
  value: unknown;
  onChange: (v: string) => void;
  firstDay: number;
  testId?: string;
}) => {
  const [open, setOpen] = useState(false);
  const [calendar, setCalendar] = useState(false);
  const rel = parseRelativeDay(value);
  const [days, setDays] = useState(rel ? String(rel.n) : '7');
  // The rule this element shows changed from outside (a rule above it was removed): the day count follows it
  // (audit 2026-10-10, web #2/#3).
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (rel && Number(days) !== rel.n) setDays(String(rel.n));
  }
  const exact = typeof value === 'string' && value.startsWith('EXACT:') ? value.slice(6) : null;
  const close = () => {
    setOpen(false);
    setCalendar(false);
  };
  const pickDays = (dir: 'ago' | 'ahead') => {
    const n = Number(days);
    if (!Number.isFinite(n) || n < 0 || days.trim() === '') return;
    onChange(relativeDayValue(dir, n));
    close();
  };
  return (
    <div className="relative">
      <button
        type="button"
        data-testid={testId}
        onClick={() => setOpen(true)}
        className={cn(inputClass, 'flex w-40 items-center justify-between', !value && 'text-muted')}
      >
        <span className="truncate">{dateValueLabel(value) ?? t('filter.pickDate')}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
          className="shrink-0 text-muted"
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <Popover open={open} onClose={close} className="w-72">
        {calendar ? (
          <Calendar
            mode="single"
            weekStartsOn={firstDay}
            value={exact}
            onChange={(iso) => {
              if (iso) onChange(`EXACT:${iso}`);
              close();
            }}
          />
        ) : (
          <div className="grid grid-cols-2 gap-0.5" data-testid="date-choices">
            {DATE_TOKEN_CHOICES.map((tok) => (
              <button
                key={tok}
                type="button"
                data-testid="date-choice"
                data-value={tok}
                onClick={() => {
                  onChange(tok);
                  close();
                }}
                className={cn(
                  'rounded-[var(--radius-sm)] px-2 py-1 text-start text-sm hover:bg-surface-2',
                  value === tok && 'bg-primary-soft text-primary',
                )}
              >
                {t(`filter.date.${tok}` as MessageKey)}
              </button>
            ))}
            <div className="col-span-2 mt-1 flex items-center gap-1.5 border-t border-line px-1 pt-2 text-sm">
              <input
                className={cn(inputClass, 'h-8 w-16')}
                inputMode="numeric"
                dir="ltr"
                value={days}
                aria-label={t('filter.date.days')}
                data-testid="date-days"
                onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
                onKeyDown={(e) => e.key === 'Enter' && pickDays('ago')}
              />
              <button
                type="button"
                data-testid="date-days-ago"
                onClick={() => pickDays('ago')}
                className={cn(
                  'rounded-[var(--radius-sm)] px-2 py-1 hover:bg-surface-2',
                  rel?.dir === 'ago' && 'bg-primary-soft text-primary',
                )}
              >
                {t('filter.date.daysAgoShort')}
              </button>
              <button
                type="button"
                data-testid="date-days-ahead"
                onClick={() => pickDays('ahead')}
                className={cn(
                  'rounded-[var(--radius-sm)] px-2 py-1 hover:bg-surface-2',
                  rel?.dir === 'ahead' && 'bg-primary-soft text-primary',
                )}
              >
                {t('filter.date.daysAheadShort')}
              </button>
            </div>
            <button
              type="button"
              data-testid="date-exact"
              onClick={() => setCalendar(true)}
              className="col-span-2 mt-1 rounded-[var(--radius-sm)] border-t border-line px-2 py-1.5 text-start text-sm text-primary hover:bg-surface-2"
            >
              {t('filter.date.exact')}
            </button>
          </div>
        )}
      </Popover>
    </div>
  );
};

/** The number a typed text means for the rule: empty / not a number = null. */
const numberOf = (text: string) => {
  const n = Number(text);
  return text.trim() === '' || !Number.isFinite(n) ? null : n;
};

/**
 * A number input that keeps what is typed ("5." stays "5.") yet follows the rule it shows: when the rule's value
 * changes from outside — the rule above it was removed and this element now shows another rule (audit
 * 2026-10-10, web #2/#3) — the text is reset, so the input never shows a number the rule does not have.
 * `width`: the Tailwind width class.
 */
export const NumberValue = ({
  value,
  onChange,
  width = 'w-20',
}: {
  value: unknown;
  onChange: (v: number | null) => void;
  width?: string;
}) => {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (numberOf(text) !== (value ?? null)) setText(value === null || value === undefined ? '' : String(value));
  }
  return (
    <input
      className={cn(inputClass, width)}
      inputMode="decimal"
      dir="ltr"
      value={text}
      placeholder="0"
      data-testid="rule-number"
      onChange={(e) => {
        setText(e.target.value);
        onChange(numberOf(e.target.value));
      }}
    />
  );
};

/**
 * The values of a date rule by operator: `within the last / next` = N + unit, `between` = two values, else one value
 * (on / not on / before / after). Shared by the board's filter builder and the dashboard widget filter.
 */
export const DateRuleValues = ({
  operator,
  values,
  onChange,
  firstDay,
}: {
  operator: FilterOperator;
  values: unknown[];
  onChange: (values: unknown[]) => void;
  firstDay: number;
}) => {
  if (operator === 'within_the_last' || operator === 'within_the_next') {
    const unit = (values[1] as string) ?? 'days';
    return (
      <span className="flex items-center gap-1">
        <NumberValue value={values[0]} onChange={(v) => onChange(v === null ? [] : [v, unit])} />
        <PickerButton
          label={t(`filter.unit.${unit}` as MessageKey)}
          placeholder=""
          menuLabel={t('filter.unit')}
          className="h-9 w-28"
          items={DATE_UNITS.map((u) => ({
            label: t(`filter.unit.${u}`),
            checked: u === unit,
            onSelect: () => onChange([values[0] ?? 1, u]),
          }))}
        />
      </span>
    );
  }
  if (operator === 'between')
    return (
      <span className="flex items-center gap-1">
        <DateValue firstDay={firstDay} value={values[0]} onChange={(v) => onChange([v, values[1] ?? v])} />
        <span className="text-xs text-muted">{t('filter.and')}</span>
        <DateValue firstDay={firstDay} value={values[1]} onChange={(v) => onChange([values[0] ?? v, v])} />
      </span>
    );
  return <DateValue firstDay={firstDay} value={values[0]} onChange={(v) => onChange([v])} />;
};
