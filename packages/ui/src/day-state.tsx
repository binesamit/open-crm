// SPDX-License-Identifier: AGPL-3.0-only
import { DAY_STATES, t, type DayState } from '@bines/shared';
import { cn } from './components';
import { DAY_MARK_CLASS } from './calendar';
import { Menu, useActionMenu } from './menu';

/** A day state's chip colours: the calendars' own, and "not shown" in grey. */
export const DAY_STATE_PILL: Record<DayState, string> = {
  ...DAY_MARK_CLASS,
  ignore: 'bg-surface-2 text-muted',
};

/** A holiday's state as a coloured chip ("יום חופש", "חצי יום" …), regular weight. */
export const DayStatePill = ({ state, className }: { state: DayState; className?: string }) => (
  <span
    className={cn('inline-flex rounded-full px-2.5 text-xs font-normal leading-5', DAY_STATE_PILL[state], className)}
  >
    {t(`dayState.${state}`)}
  </span>
);

/**
 * A holiday's state picked from a menu: the chip is the trigger (the approved canvas: the state itself, coloured,
 * not a form field). Never a native select.
 */
export const DayStateMenu = ({
  value,
  onChange,
  label,
  testId,
  disabled,
}: {
  value: DayState;
  onChange: (state: DayState) => void;
  /** Accessible name (the holiday's name). */
  label: string;
  testId?: string;
  disabled?: boolean;
}) => {
  const menu = useActionMenu();
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-label={`${label}: ${t(`dayState.${value}`)}`}
        data-testid={testId}
        data-state={value}
        disabled={disabled}
        onClick={menu.fromTrigger}
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-2.5 text-xs font-normal leading-6 focus:outline-none focus-visible:ring-3 focus-visible:ring-[var(--accent-soft)] disabled:opacity-60',
          DAY_STATE_PILL[value],
        )}
      >
        {t(`dayState.${value}`)}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <Menu
        at={menu.at}
        onClose={menu.close}
        label={label}
        searchable={false}
        items={DAY_STATES.map((s) => ({
          label: t(`dayState.${s}`),
          checked: s === value,
          testId: testId ? `${testId}-${s}` : undefined,
          onSelect: () => onChange(s),
        }))}
      />
    </>
  );
};
