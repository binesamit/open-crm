// SPDX-License-Identifier: AGPL-3.0-only
import { type KeyboardEvent } from 'react';
import { t, type MessageKey } from '@bines/shared';
import { cn, PALETTES, type Palette } from '@bines/ui';
import { usePalette } from '../../lib/theme';

/** The palette's three colours (shell, tint, accent) as a small swatch. */
export const PaletteSwatch = ({ palette, size = 16 }: { palette: Palette; size?: number }) => (
  <span aria-hidden className="flex shrink-0 overflow-hidden rounded-full border border-line" style={{ height: size }}>
    {palette.swatch.map((c, i) => (
      <span key={i} style={{ backgroundColor: c, width: size / 2 }} />
    ))}
  </span>
);

/**
 * Round 12: the colour theme picker of the profile's appearance tab — one card per palette (its swatch and name),
 * a radio group (←/→ move). Every palette is AA in light and dark (`palettes.test.ts`).
 */
export const PalettePicker = () => {
  const [current, choose] = usePalette();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const rtl = document.documentElement.dir === 'rtl';
    const forward = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
    const i = PALETTES.findIndex((p) => p.id === current);
    const next = PALETTES[(i + (forward ? 1 : PALETTES.length - 1)) % PALETTES.length]!;
    choose(next.id);
    e.currentTarget.querySelector<HTMLElement>(`[data-palette-id="${next.id}"]`)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={t('r12.palette.title')}
      data-testid="palette-picker"
      onKeyDown={onKey}
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
    >
      {PALETTES.map((p) => {
        const on = p.id === current;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-testid={`palette-${p.id}`}
            data-palette-id={p.id}
            onClick={() => choose(p.id)}
            className={cn(
              'flex items-center gap-2.5 rounded-[var(--radius)] border px-3 py-2.5 text-start text-sm',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
              on ? 'border-primary bg-primary-soft font-semibold text-primary' : 'border-line hover:bg-surface-2',
            )}
          >
            <PaletteSwatch palette={p} size={20} />
            <span className="truncate">{t(p.label as MessageKey)}</span>
          </button>
        );
      })}
    </div>
  );
};
