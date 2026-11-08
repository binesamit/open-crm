// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn, Menu, useActionMenu, type MenuEntry } from '@bines/ui';
import { Popover } from '../cells/Popover';
import { Icon, type IconName } from '../../../lib/icons';

/**
 * Building blocks of the board toolbar (13-FILTERS §4.1). Every chooser is a system Menu/Popover —
 * never a native <select> (M1.1 #9).
 */

/** Toolbar panels inside it show their icon only (F4: "view settings" is an icon button); the label stays for AT. */
export const ToolbarIconOnly = createContext(false);

/**
 * Prod fix (mobilehead): the phone's tools sheet — every tool is a full-width row with its label (never an icon
 * only), its count at the row's end; the panels open as bottom sheets over it.
 */
export const ToolbarSheet = createContext(false);

/**
 * A toolbar button that opens a panel under it; `active` shows the "filter is on" dot and count.
 * F4: a ghost btn-sm; `dashed` = the filter's dashed outline.
 */
export const ToolbarPanel = ({
  label,
  icon,
  active,
  count,
  children,
  panelClassName,
  testId,
  tour,
  variant = 'ghost',
  scrim,
  plainCount,
  countTitle,
  compact,
}: {
  label: string;
  icon: IconName;
  active?: boolean;
  count?: number;
  children: (close: () => void) => ReactNode;
  panelClassName?: string;
  testId?: string;
  /** The product-tour anchor (`data-tour`) of the button. */
  tour?: string;
  variant?: 'ghost' | 'dashed';
  /** Phones: the panel is a bottom sheet — dim the page behind it (a tap on the scrim closes it). */
  scrim?: boolean;
  /** The count as a plain number in the button's ink (owner fix 5: the filter's — no blue badge). */
  plainCount?: boolean;
  /** Tooltip of the button while it counts something (e.g. the active conditions, one per line). */
  countTitle?: string;
  /** Round 12: the icon only (plus its count badge) at every width; the label is the tooltip and the name. */
  compact?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const sheet = useContext(ToolbarSheet);
  const iconOnlyCtx = useContext(ToolbarIconOnly);
  const iconOnly = !sheet && (iconOnlyCtx || !!compact);
  return (
    <div className={cn('relative', sheet && 'w-full')}>
      <button
        type="button"
        data-testid={testId}
        data-tour={tour}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : count && countTitle ? countTitle : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-[10px] border border-transparent px-2.5 text-sm text-fg-2 hover:bg-surface-2 hover:text-fg',
          variant === 'dashed' && 'border-dashed border-line-strong',
          iconOnly && (count ? 'min-w-8 justify-center gap-1 px-1.5' : 'w-8 justify-center px-0'),
          (active || open) && 'bg-primary-soft font-medium text-primary hover:bg-primary-soft hover:text-primary',
          sheet && SHEET_ROW,
        )}
      >
        <Icon name={icon} size={sheet ? 18 : 15} />
        {/* Phones show icons only, except the dashed filter, which keeps its label (F4). */}
        <span
          className={
            sheet
              ? 'min-w-0 flex-1 truncate text-start'
              : iconOnly
                ? 'sr-only'
                : variant === 'dashed'
                  ? undefined
                  : 'max-md:sr-only'
          }
        >
          {label}
        </span>
        {count && plainCount ? (
          <span data-testid={testId ? `${testId}-count` : undefined} className="text-heading tabular-nums">
            {count}
          </span>
        ) : count ? (
          <span className="rounded-full bg-primary px-1.5 text-[0.6875rem] leading-4 text-on-primary">{count}</span>
        ) : active ? (
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
        ) : null}
      </button>
      {scrim && open
        ? createPortal(
            <div aria-hidden className="anim-scrim fixed inset-0 z-popover bg-[var(--scrim)] md:hidden" />,
            document.body,
          )
        : null}
      <Popover open={open} onClose={() => setOpen(false)} className={cn('p-3', panelClassName)}>
        {children(() => setOpen(false))}
      </Popover>
    </div>
  );
};

/** A tool as a row of the phone's tools sheet (`ToolbarSheet`). */
export const SHEET_ROW = 'h-11 w-full justify-start gap-3 border-transparent px-3 text-[0.9375rem]';

/** A button showing the current choice; click opens a Menu of choices. */
export const PickerButton = ({
  label,
  placeholder,
  items,
  menuLabel,
  className,
  testId,
  searchable,
}: {
  label?: string;
  placeholder: string;
  items: MenuEntry[];
  menuLabel: string;
  className?: string;
  testId?: string;
  /** See `Menu`: long lists get a search field by default. */
  searchable?: boolean;
}) => {
  const menu = useActionMenu();
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        onClick={menu.fromTrigger}
        className={cn(
          'flex h-8 min-w-0 items-center justify-between gap-2 rounded-[10px] border border-line-strong bg-surface px-2.5 text-start text-sm hover:border-primary',
          !label && 'text-muted',
          className,
        )}
      >
        <span className="truncate">{label ?? placeholder}</span>
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
      <Menu at={menu.at} onClose={menu.close} items={items} label={menuLabel} searchable={searchable} />
    </>
  );
};

/** A row with a check box look (a button, so it works the same everywhere). */
export const CheckRow = ({
  checked,
  onToggle,
  children,
  className,
  disabled,
  testId,
}: {
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  testId?: string;
}) => (
  <button
    type="button"
    role="checkbox"
    aria-checked={checked}
    disabled={disabled}
    onClick={onToggle}
    data-testid={testId}
    className={cn(
      'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-start text-sm hover:bg-surface-2',
      disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
      className,
    )}
  >
    <span
      aria-hidden
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[3px] border text-[0.6875rem] leading-none',
        checked ? 'border-primary bg-primary text-on-primary' : 'border-line',
      )}
    >
      {checked ? '✓' : ''}
    </span>
    <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
  </button>
);

export const IconButton = ({
  label,
  onClick,
  children,
  className,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
    className={cn(
      'flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40',
      className,
    )}
  >
    {children}
  </button>
);
