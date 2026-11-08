// SPDX-License-Identifier: AGPL-3.0-only
import type { KeyboardEvent } from 'react';
import { ICON_STYLES, type IconStyle, t } from '@bines/shared';
import { cn } from '@bines/ui';
import { Icon, type IconName } from '../../lib/icons';

/** The sample icons on each card: a main shape, a view, a detail on a shape, an accent. */
const SAMPLE: IconName[] = ['home', 'board', 'calendar', 'bolt'];

/**
 * the icon style, as cards that each show the icons in that style — Profile → Appearance (mine) and
 * Administration → General (the account's default). The list is `ICON_STYLES`; a new style shows up here by itself.
 */
export const IconStylePicker = ({
  value,
  onChange,
  label,
  testId = 'icon-style-picker',
}: {
  value: IconStyle;
  onChange: (v: IconStyle) => void;
  label: string;
  testId?: string;
}) => {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const rtl = document.documentElement.dir === 'rtl';
    const forward = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
    const i = ICON_STYLES.indexOf(value);
    const next = ICON_STYLES[(i + (forward ? 1 : ICON_STYLES.length - 1)) % ICON_STYLES.length]!;
    onChange(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-icon-style-id="${next}"]`)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      onKeyDown={onKeyDown}
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
    >
      {ICON_STYLES.map((k) => {
        const on = value === k;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-testid={`${testId}-${k}`}
            data-icon-style-id={k}
            onClick={() => onChange(k)}
            className={cn(
              'flex min-w-0 flex-col items-center justify-center gap-1.5 rounded-[var(--radius)] border px-2 py-2.5 text-center text-sm',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
              on ? 'border-primary bg-primary-soft text-primary' : 'border-line text-fg hover:bg-surface-2',
            )}
          >
            <span aria-hidden className="flex items-center gap-2">
              {SAMPLE.map((n) => (
                <Icon key={n} name={n} size={18} iconStyle={k} />
              ))}
            </span>
            <span className="max-w-full text-xs [overflow-wrap:anywhere]">{t(`iconStyle.${k}`)}</span>
          </button>
        );
      })}
    </div>
  );
};
