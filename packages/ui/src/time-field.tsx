// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { placeFloating } from './position';
import { cn } from './components';
import { useLayer } from './layers';

/**
 * Time picker (M1.1): one click opens one panel with two separate columns — hours 00–23 and minutes 00–59.
 * Picking an hour keeps the panel open; picking a minute closes it (open → hour → minute = 3 clicks).
 * Fixed-positioned (a scrolling drawer never clips it), both columns start scrolled to the current value.
 * Keyboard: ←/→ switch column, ↑/↓ move, Enter picks, Esc closes, typing two digits jumps.
 */
const pad = (n: number) => String(n).padStart(2, '0');
const PANEL_HEIGHT = 240;
/** The two columns' width (hours + minutes) — for placing the panel before it renders. */
const PANEL_WIDTH = 132;

const Column = ({
  id,
  testId,
  label,
  count,
  value,
  active,
  focused,
  onPick,
  onHover,
}: {
  id: string;
  testId?: string | undefined;
  label: string;
  count: number;
  value: number;
  active: number;
  focused: boolean;
  onPick: (n: number) => void;
  onHover: (n: number) => void;
}) => {
  const ref = useRef<HTMLUListElement>(null);
  const scrollTo = (n: number, block: ScrollLogicalPosition) =>
    ref.current?.querySelector<HTMLElement>(`[data-v="${n}"]`)?.scrollIntoView({ block });
  // The column mounts with the panel: start centred on the current value; keyboard moves stay in view.
  const [initial] = useState(value);
  useLayoutEffect(() => {
    scrollTo(initial, 'center');
  }, [initial]);
  useEffect(() => {
    scrollTo(active, 'nearest');
  }, [active]);
  return (
    <ul
      ref={ref}
      id={id}
      data-testid={testId}
      role="listbox"
      aria-label={label}
      aria-activedescendant={`${id}-${active}`}
      className={cn(
        'max-h-60 w-14 overflow-auto rounded-[var(--radius-sm)] p-0.5',
        focused && 'ring-2 ring-[var(--primary-soft)]',
      )}
    >
      {Array.from({ length: count }, (_, n) => (
        <li
          key={n}
          id={`${id}-${n}`}
          data-v={n}
          role="option"
          aria-selected={n === value}
          onMouseEnter={() => onHover(n)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(n)}
          className={cn(
            'cursor-pointer rounded-[var(--radius-sm)] py-1 text-center font-mono text-sm',
            n === value
              ? 'bg-primary font-semibold text-on-primary'
              : n === active && focused
                ? 'bg-primary-soft'
                : 'hover:bg-surface-2',
          )}
        >
          {pad(n)}
        </li>
      ))}
    </ul>
  );
};

/** `value` / `onChange` as "HH:mm" (24h). */
export const TimeField = ({
  value,
  onChange,
  label,
  hourLabel,
  minuteLabel,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  hourLabel: string;
  minuteLabel: string;
  /** The button's test id; the panel's columns are `<testId>-hours` / `<testId>-minutes`. */
  testId?: string;
}) => {
  const [h0, m0] = value.split(':').map(Number) as [number, number];
  const h = h0 || 0;
  const m = m0 || 0;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [col, setCol] = useState<'h' | 'm'>('h');
  const [active, setActive] = useState({ h, m });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const typed = useRef('');
  const id = useId();

  const show = () => {
    // Round 12: the shared placement rule — below or above, lined up with the field, inside the screen.
    const p = placeFloating(
      button.current!.getBoundingClientRect(),
      { width: PANEL_WIDTH, height: PANEL_HEIGHT + 16 },
      { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight },
      { rtl: document.documentElement.dir === 'rtl' },
    );
    setPos({ left: p.left, top: p.top });
    setActive({ h, m });
    setCol('h');
    typed.current = '';
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) button.current?.focus();
  };
  const pickHour = (x: number) => {
    onChange(`${pad(x)}:${pad(m)}`);
    setActive((a) => ({ ...a, h: x }));
    setCol('m'); // stay open for the minutes
  };
  const pickMinute = (x: number) => {
    onChange(`${pad(h)}:${pad(x)}`);
    close();
  };

  useLayoutEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  // Outside press / Esc through the shared layer stack (round 9: every popover closes the same way).
  useLayer(
    panel,
    open,
    () => close(false),
    () => close(),
    () => button.current,
  );
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) close(false);
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const count = col === 'h' ? 24 : 60;
    const cur = active[col];
    const move = (n: number) => setActive((a) => ({ ...a, [col]: (n + count) % count }));
    if (e.key === 'ArrowDown') move(cur + 1);
    else if (e.key === 'ArrowUp') move(cur - 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      typed.current = '';
      setCol((c) => (c === 'h' ? 'm' : 'h'));
    } else if (e.key === 'Enter' || e.key === ' ') {
      typed.current = '';
      (col === 'h' ? pickHour : pickMinute)(cur);
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // closes the picker only, not the drawer around it
      close();
    } else if (e.key === 'Tab') close(false);
    else if (/^\d$/.test(e.key)) {
      typed.current = (typed.current + e.key).slice(-2);
      const n = Number(typed.current);
      if (n < count) setActive((a) => ({ ...a, [col]: n }));
      return;
    } else return;
    e.preventDefault();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            show();
          }
        }}
        dir="ltr"
        className={cn(
          'h-8 rounded-[var(--radius-sm)] border bg-surface px-2.5 font-mono text-sm hover:border-primary',
          open ? 'border-primary ring-2 ring-[var(--primary-soft)]' : 'border-line',
        )}
      >
        {pad(h)}:{pad(m)}
      </button>
      {open && pos ? (
        <div
          ref={panel}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onKey}
          dir="ltr"
          style={{ left: pos.left, top: pos.top }}
          className="fixed z-popover flex items-start gap-1 rounded-[var(--radius)] border border-line bg-surface p-1.5 shadow-[var(--shadow-pop)] outline-none"
        >
          <Column
            id={`${id}-h`}
            testId={testId && `${testId}-hours`}
            label={`${label} — ${hourLabel}`}
            count={24}
            value={h}
            active={active.h}
            focused={col === 'h'}
            onPick={pickHour}
            onHover={(n) => setActive((a) => ({ ...a, h: n }))}
          />
          <span aria-hidden className="self-center font-mono text-muted">
            :
          </span>
          <Column
            id={`${id}-m`}
            testId={testId && `${testId}-minutes`}
            label={`${label} — ${minuteLabel}`}
            count={60}
            value={m}
            active={active.m}
            focused={col === 'm'}
            onPick={pickMinute}
            onHover={(n) => setActive((a) => ({ ...a, m: n }))}
          />
        </div>
      ) : null}
    </>
  );
};
