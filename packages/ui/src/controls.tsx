// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from './components';

/** F4 controls from the canvas's components sheet: switch, segmented switch, radio card, tabs, empty state. */

/** On / off (`.sw`): 36×20, green when on. A real checkbox with role="switch", so labels and keys just work. */
export const Switch = ({
  checked,
  onChange,
  label,
  disabled,
  className,
  testId,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  /** The accessible name when there is no visible <label> around it. */
  label?: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) => (
  <input
    type="checkbox"
    role="switch"
    aria-label={label}
    checked={checked}
    disabled={disabled}
    data-testid={testId}
    onChange={(e) => onChange(e.target.checked)}
    className={cn(
      'relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-[var(--control-line)] transition-colors checked:bg-ok disabled:cursor-not-allowed disabled:opacity-50',
      "after:absolute after:top-0.5 after:start-0.5 after:size-4 after:rounded-full after:bg-white after:shadow-[0_1px_2px_rgba(0,0,0,0.25)] after:transition-[inset-inline-start] after:content-['']",
      'checked:after:start-[18px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
      className,
    )}
  />
);

/** One of a few (`.seg`): a track with buttons; the chosen one is filled with the brand ink. */
export const Segmented = <T extends string>({
  value,
  options,
  onChange,
  label,
  className,
  testId,
}: {
  value: T;
  /** `disabled`: shown but not choosable (say why next to the control). */
  options: { value: T; label: ReactNode; icon?: ReactNode; testId?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
  testId?: string;
}) => (
  <div
    role="radiogroup"
    aria-label={label}
    data-testid={testId}
    className={cn(
      'inline-flex max-w-full gap-0.5 overflow-x-auto rounded-[12px] bg-surface-2 p-[0.1875rem]',
      className,
    )}
  >
    {options.map((o) => (
      <button
        key={o.value}
        type="button"
        role="radio"
        aria-checked={value === o.value}
        data-testid={o.testId}
        disabled={o.disabled}
        onClick={() => onChange(o.value)}
        className={cn(
          'inline-flex h-[1.875rem] shrink-0 items-center justify-center gap-1.5 rounded-[9px] px-3.5 text-[0.8125rem] whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-45',
          value === o.value ? 'bg-primary font-semibold text-on-primary' : 'text-fg-2 enabled:hover:text-fg',
        )}
      >
        {o.icon}
        {o.label}
      </button>
    ))}
  </div>
);

/** A choice with a title and an explanation (`.radio`): a bordered card, the chosen one outlined in the ink. */
export const RadioCard = ({
  checked,
  onSelect,
  title,
  hint,
  icon,
  name,
  disabled,
  testId,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  title: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  name: string;
  disabled?: boolean;
  testId?: string;
  /** Extra controls shown inside the card (e.g. the digest's day and hour). */
  children?: ReactNode;
}) => (
  <label
    data-testid={testId}
    className={cn(
      'flex cursor-pointer items-start gap-2.5 rounded-[12px] border p-3',
      checked
        ? 'border-heading bg-surface-3 shadow-[inset_0_0_0_1px_var(--heading)]'
        : 'border-line hover:bg-surface-3',
      disabled && 'cursor-not-allowed opacity-50',
    )}
  >
    <input
      type="radio"
      name={name}
      checked={checked}
      disabled={disabled}
      onChange={onSelect}
      className="mt-0.5 size-[0.9375rem] shrink-0 accent-[var(--check)]"
    />
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex items-center gap-1.5 font-semibold text-fg">
        {icon}
        {title}
      </span>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      {children ? <span className="mt-2 flex flex-wrap gap-2">{children}</span> : null}
    </span>
  </label>
);

/**
 * Underlined tabs (`.tabs`): the active one in the heading ink with an amber underline. r16motion: the underline is
 * one bar that slides to the chosen tab (transform + width, ~180ms; instant with animations reduced / off). Until it
 * is measured (or where nothing is laid out) the active tab draws its own border, as before.
 */
export const Tabs = <T extends string>({
  value,
  tabs,
  onChange,
  className,
}: {
  value: T;
  tabs: { value: T; label: ReactNode; icon?: ReactNode; testId?: string }[];
  onChange: (v: T) => void;
  className?: string;
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);
  const keys = tabs.map((x) => x.value).join('|');
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      const next = tab && tab.offsetWidth ? { left: tab.offsetLeft, width: tab.offsetWidth } : null;
      setBar((cur) => (cur?.left === next?.left && cur?.width === next?.width ? cur : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    list.querySelectorAll('[role="tab"]').forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [value, keys]);
  return (
    <div
      role="tablist"
      ref={listRef}
      className={cn('relative flex gap-5 overflow-x-auto border-b border-line', className)}
    >
      {tabs.map((x) => (
        <button
          key={x.value}
          type="button"
          role="tab"
          aria-selected={value === x.value}
          data-testid={x.testId}
          onClick={() => onChange(x.value)}
          className={cn(
            '-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 text-[0.8125rem] whitespace-nowrap',
            value === x.value
              ? cn(bar ? 'border-transparent' : 'border-accent', 'font-semibold text-heading')
              : 'border-transparent text-muted hover:text-fg',
          )}
        >
          {x.icon}
          {x.label}
        </button>
      ))}
      {bar ? (
        <span
          aria-hidden
          data-tab-indicator
          className="tab-indicator pointer-events-none absolute -bottom-px left-0 h-0.5 bg-accent"
          style={{ width: bar.width, transform: `translateX(${bar.left}px)` }}
        />
      ) : null}
    </div>
  );
};

/** Nothing here yet (`.empty`): an icon tile, a title, a line of help and an optional action. */
export const EmptyState = ({
  icon,
  title,
  children,
  action,
  testId,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  testId?: string;
  className?: string;
}) => (
  <div
    data-testid={testId}
    className={cn('flex flex-col items-center justify-center gap-2.5 px-4 py-12 text-center text-muted', className)}
  >
    {icon ? (
      <span className="grid size-16 place-items-center rounded-[20px] bg-surface-2 text-heading">{icon}</span>
    ) : null}
    <span className="font-display text-[0.9375rem] font-bold text-heading">{title}</span>
    {children ? <span className="max-w-sm text-[0.8125rem]">{children}</span> : null}
    {action}
  </div>
);

/** Loading placeholder (`.skel`): a 12px rounded bar on surface-2 that pulses gently. Width via className/style. */
export const Skeleton = ({ className, style }: { className?: string; style?: CSSProperties }) => (
  <span
    aria-hidden
    style={style}
    className={cn('block h-3 animate-pulse rounded-[6px] bg-surface-2 motion-reduce:animate-none', className)}
  />
);

/**
 * Rows of skeleton bars (`.skel` rows on the canvas) instead of "loading…": a short bar and a long one per row.
 * `label` is read by screen readers (role="status").
 */
export const SkeletonRows = ({
  rows = 3,
  label,
  className,
  testId = 'skeleton',
}: {
  rows?: number;
  label: string;
  className?: string;
  testId?: string;
}) => (
  <div role="status" aria-label={label} data-testid={testId} className={cn('flex flex-col gap-2.5 py-2', className)}>
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="flex items-center gap-2.5">
        <Skeleton className="w-5 shrink-0" />
        <Skeleton style={{ width: `${[80, 60, 70][i % 3]}%` }} />
      </div>
    ))}
  </div>
);
