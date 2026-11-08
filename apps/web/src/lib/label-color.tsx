// SPDX-License-Identifier: AGPL-3.0-only
import type { CSSProperties, ReactNode } from 'react';
import {
  colorHex,
  hasMessage,
  paint,
  paintLabel,
  PALETTE_GROUPS,
  paletteGroupOf,
  t,
  tDynamic,
  type ColorKey,
} from '@bines/shared';
import { cn, inkOf } from '@bines/ui';

/**
 * Our label look (11-UI §9.1): stored colours are palette keys, painted as `var(--c-<key>)` so dark mode follows.
 * A label is a chip (`.label-tag` in styles.css, "ג2": a strong tint of its colour, the text in a deep
 * shade of it); the status cell is the same tint, edge to edge. `--tag` stays the vivid colour.
 */
export const tagVars = (color: string | null | undefined): CSSProperties => {
  const painted = paint(color);
  // A colour outside the palette (old raw data) keeps the solid fill with white text.
  const label = paintLabel(color) ?? (painted ? { soft: painted, ink: 'var(--on-c)' } : undefined);
  return {
    '--tag': painted ?? 'var(--status-empty)',
    ...(label ? { '--tag-soft': label.soft, '--tag-ink': label.ink } : {}),
  } as CSSProperties;
};

/** A full fill in a label's colour (a status cell, a battery segment, a bar, a swatch); text on it takes `--on-c`. */
export const fill = (color: string | null | undefined): CSSProperties => ({
  backgroundColor: paint(color) ?? 'var(--status-empty)',
});

/**
 * Text in a colour (a group's name): the colour itself where it reads on the surface in every theme, else the colour
 * mixed toward the theme's ink until it does (`inkOf`). Takes a stored colour or a painted `var(--c-<key>)`.
 */
export const inkFor = (color: string | null | undefined): string | undefined => {
  const key = /^var\(--c-([a-z_]+)\)$/.exec(color ?? '')?.[1] ?? color;
  const hex = colorHex(key, 'light', null);
  return hex ? inkOf(hex) : (color ?? undefined);
};

/** The name of a palette colour, for a swatch's label ("Amber"); a non-key is shown as is. */
export const colorName = (color: string): string => {
  const key = `color.${color}`;
  return hasMessage(key) ? tDynamic(key) : color;
};

/** The colour picker's sections (pal40): vivid (2 rows), deep with the neutral greys (2 rows), soft (1 row). */
const PICKER_SECTIONS = [
  { id: 'vivid', keys: PALETTE_GROUPS.vivid, label: () => t('color.group.vivid') },
  {
    id: 'deep',
    keys: [...PALETTE_GROUPS.deep, ...PALETTE_GROUPS.neutral],
    label: () => `${t('color.group.deep')} · ${t('color.group.neutral')}`,
  },
  { id: 'soft', keys: PALETTE_GROUPS.soft, label: () => t('color.group.soft') },
] as const;

/**
 * A swatch that shows a colour the way a label wears it (product owner: "when editing statuses the
 * colours must be the ones the table really shows"): the chip's tint as the background and a dot in its ink, so the
 * label editor, the convert dialog and the import review pick from what the cell will look like, not from the vivid
 * colour the bars and groups use. Takes a stored key; `tagVars` resolves the tint and ink (dark mode follows).
 */
export const LabelSwatch = ({
  color,
  className,
  dot = 'size-2',
}: {
  color: string | null | undefined;
  className?: string;
  /** The ink dot's size classes. */
  dot?: string;
}) => (
  <span
    className={cn('label-tag inline-flex shrink-0 items-center justify-center', className)}
    style={tagVars(color)}
    aria-hidden
  >
    <span className={cn('rounded-full', dot)} style={{ backgroundColor: 'var(--tag-ink)' }} />
  </span>
);

/**
 * The app's colour picker (pal40): all forty palette colours as swatches, five rows of eight
 * vivid, deep (the neutral greys finish its second row), soft — each family a labelled group. One component for
 * every place a label / group / tag / colouring colour is chosen; `kind` keeps each place's own semantics (a radio
 * group, a list box option, a toggle) and `itemTestId` its test id. Values are palette keys. `look`: `fill` (round,
 * the vivid colour — groups, tags, bars) or `label` (a rounded square in the chip's tint with an ink dot — exactly
 * what a status label looks like in the table).
 */
export const ColorGrid = ({
  selected,
  onPick,
  kind = 'radio',
  look = 'fill',
  label,
  testId,
  itemTestId,
  size = 'sm',
  className,
  itemClassName,
  renderItem,
}: {
  selected: (key: ColorKey) => boolean;
  onPick: (key: ColorKey) => void;
  kind?: 'radio' | 'option' | 'pressed';
  look?: 'fill' | 'label';
  label: string;
  testId?: string;
  itemTestId?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /** Extra classes per swatch (replaces the default ring for the selected one). */
  itemClassName?: (key: ColorKey, selected: boolean) => string;
  renderItem?: (key: ColorKey) => ReactNode;
}) => {
  const role = kind === 'radio' ? 'radiogroup' : kind === 'option' ? 'listbox' : 'group';
  const asLabel = look === 'label';
  return (
    <div role={role} aria-label={label} data-testid={testId} className={cn('flex flex-col gap-1.5', className)}>
      {PICKER_SECTIONS.map((s) => (
        <div
          key={s.id}
          role="group"
          aria-label={s.label()}
          data-color-group={s.id}
          className={cn('grid grid-cols-8', size === 'sm' ? 'gap-1' : 'gap-1.5')}
        >
          {s.keys.map((c) => {
            const on = selected(c);
            return (
              <button
                key={c}
                type="button"
                role={kind === 'pressed' ? undefined : kind}
                aria-checked={kind === 'radio' ? on : undefined}
                aria-selected={kind === 'option' ? on : undefined}
                aria-pressed={kind === 'pressed' ? on : undefined}
                aria-label={colorName(c)}
                title={colorName(c)}
                data-testid={itemTestId}
                data-color={c}
                data-family={paletteGroupOf(c)}
                onClick={() => onPick(c)}
                data-look={asLabel ? 'label' : undefined}
                className={cn(
                  'shrink-0',
                  asLabel
                    ? 'label-tag rounded-[var(--radius-sm)] p-0 hover:ring-2 hover:ring-[var(--tag-ink)]'
                    : 'rounded-full',
                  size === 'sm' ? 'size-5' : size === 'md' ? 'size-6' : 'size-7',
                  itemClassName
                    ? itemClassName(c, on)
                    : on &&
                        (asLabel
                          ? 'ring-2 ring-[var(--tag-ink)] ring-offset-1 ring-offset-[var(--surface)]'
                          : 'ring-2 ring-heading ring-offset-1 ring-offset-[var(--surface)]'),
                )}
                style={asLabel ? tagVars(c) : fill(c)}
              >
                {renderItem ? (
                  renderItem(c)
                ) : asLabel ? (
                  <span
                    className={cn('rounded-full', size === 'sm' ? 'size-1.5' : 'size-2')}
                    style={{ backgroundColor: 'var(--tag-ink)' }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
};

export const LabelTag = ({
  color,
  children,
  className,
  title,
}: {
  color: string | null | undefined;
  children?: ReactNode;
  className?: string;
  title?: string;
}) => (
  <span
    className={cn('label-tag h-6 text-xs', className)}
    style={tagVars(color)}
    data-color={color ?? undefined}
    title={title}
  >
    <span className="truncate">{children}</span>
  </span>
);
