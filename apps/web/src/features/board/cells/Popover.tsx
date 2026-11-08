// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { autoFocusSearch, cn, floatingBoundary, placeCentred, placeFloating, useExitRef, useLayer } from '@bines/ui';

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

const GAP = 4;
const MARGIN = 8;

/**
 * Round 12 — the phone table: cell editors open as a bottom sheet (full width at the bottom of the screen, over a
 * dimmed page) instead of a small panel next to a 40px cell. Phones only (`max-md`); provided by `MobileGrid`.
 */
export const PopoverSheetContext = createContext(false);
const SHEET =
  'max-md:inset-x-0! max-md:top-auto! max-md:bottom-0! max-md:w-full! max-md:max-w-none! max-md:max-h-[75dvh]! max-md:rounded-b-none max-md:rounded-t-[20px] max-md:p-4 max-md:pb-[max(1rem,env(safe-area-inset-bottom))]';

/**
 * Anchored panel for cell editors, toolbar panels and group menus. It renders in a portal on <body> (fixed),
 * so neither the scrolling table, a later row nor the screen edge can cover or cut it (M1.1 #15): it opens below
 * its anchor — the element it is placed in — aligned to the inline-start edge, flips above when there is no
 * room, and is pushed back inside the viewport. Follows scrolling and its own size; closes on outside click / Esc
 * (nested popovers and menus close first — `useLayer`). Keyboard: once placed it takes the focus (its first
 * control, unless something inside already has it — an autofocused input), and Tab cycles inside it, since it
 * sits at the end of <body> and would otherwise tab out of the page (07 §10).
 */
export const Popover = ({
  open,
  onClose,
  onEscape,
  children,
  className,
  align = 'start',
  placement = 'anchor',
}: {
  open: boolean;
  onClose: () => void;
  /** Esc, when it differs from an outside click (a date with a time: Esc discards the pending edit). */
  onEscape?: () => void;
  children: ReactNode;
  className?: string;
  /** Which edge of the anchor the panel lines up with: inline-start (default) or inline-end (grows inward). */
  align?: 'start' | 'end';
  /**
   * `anchor` (default): next to its anchor. `centre` (pal40 — a big picker): beside the centre of the viewport, never
   * over the anchor, no backdrop (`placeCentred`). On a phone the sheet wins either way.
   */
  placement?: 'anchor' | 'centre';
}) => {
  const ref = useRef<HTMLDivElement>(null);
  // r16motion: fades out on close (a ghost copy) — the panel itself unmounts at once.
  const exitRef = useExitRef(ref);
  const marker = useRef<HTMLSpanElement>(null);
  const sheet = useContext(PopoverSheetContext);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number; maxWidth?: number } | null>(null);
  const anchor = () => marker.current?.parentElement;
  useLayer(ref, open, onClose, onEscape, anchor);

  useLayoutEffect(() => {
    if (!open) return;
    const panel = ref.current;
    const a0 = marker.current?.parentElement;
    if (!panel || !a0) return;
    // Round 12: the shared placement rule (`placeFloating`) — flip, then shift inside the screen and the dialog /
    // item card it was opened in (when it fits there).
    const place = () => {
      const a = a0.getBoundingClientRect();
      const { width } = panel.getBoundingClientRect();
      const viewport = { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight };
      const centre = placement === 'centre';
      const next = centre
        ? placeCentred(a, { width, height: panel.scrollHeight }, viewport, { margin: MARGIN, gap: MARGIN })
        : placeFloating(a, { width, height: panel.scrollHeight }, viewport, {
            align,
            rtl: getComputedStyle(a0).direction === 'rtl',
            gap: GAP,
            margin: MARGIN,
            boundary: floatingBoundary(a0),
          });
      const maxWidth = centre ? next.maxWidth : undefined;
      setPos((prev) =>
        prev &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.maxHeight === next.maxHeight &&
        prev.maxWidth === maxWidth
          ? prev
          : { left: next.left, top: next.top, maxHeight: next.maxHeight, maxWidth },
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, align, placement]);

  // Closed (Esc, outside click, a choice): the focus goes back to where it was when the panel opened — its trigger —
  // when it was inside the panel or nowhere (WCAG 2.4.3). A click elsewhere keeps that focus.
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = ref;
    return () => {
      const at = document.activeElement;
      const lost = !at || at === document.body || !at.isConnected || !!panel.current?.contains(at);
      if (before && before !== document.body && before.isConnected && lost) before.focus({ preventScroll: true });
    };
  }, [open]);

  const placed = !!pos;
  useEffect(() => {
    if (!open || !placed) return;
    const panel = ref.current;
    if (panel && !panel.contains(document.activeElement)) {
      // Phones (r23ui): never a text field — focusing it slides the keyboard over the list; it focuses on a tap.
      const typing = (el: HTMLElement) =>
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement &&
          !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(el.type));
      // `data-autofocus` (the status picker's current label) is focused first.
      const first =
        panel.querySelector<HTMLElement>('[data-autofocus]') ??
        Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).find((el) => autoFocusSearch() || !typing(el));
      first?.focus({ preventScroll: true });
    }
  }, [open, placed]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const panel = ref.current;
    if (!panel) return;
    const el = e.target as HTMLElement;
    const checks = [...panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')].filter(
      (x) => !x.disabled && x.offsetParent !== null,
    );
    const isCheck = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
    // Lists of check boxes (labels, people, teams): Enter toggles like Space, ↑ / ↓ move between them, ↓ from a
    // search field goes to the first one (07 §10 — Tab alone reached a box but Enter did nothing).
    if (isCheck && e.key === 'Enter') {
      e.preventDefault();
      el.click();
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && checks.length) {
      const typing = el instanceof HTMLInputElement && !isCheck;
      if (typing && e.key === 'ArrowDown') {
        e.preventDefault();
        checks[0]!.focus();
        return;
      }
      if (isCheck) {
        e.preventDefault();
        const i = checks.indexOf(el);
        checks[Math.max(0, Math.min(checks.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]!.focus();
        return;
      }
    }
    cycleTab(e);
  };

  const cycleTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const all = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!all.length) return;
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      all.at(-1)!.focus();
    } else if (!e.shiftKey && i === all.length - 1) {
      e.preventDefault();
      all[0]!.focus();
    }
  };

  return (
    <>
      <span ref={marker} hidden />
      {open && sheet
        ? createPortal(
            <div aria-hidden className="anim-scrim fixed inset-0 z-popover bg-[var(--scrim)] md:hidden" />,
            document.body,
          )
        : null}
      {open
        ? createPortal(
            <div
              ref={exitRef}
              data-testid="popover"
              data-sheet={sheet || undefined}
              data-placement={placement === 'centre' && !sheet ? 'centre' : undefined}
              dir={document.documentElement.dir || undefined}
              // Clicks inside must not reach the cell (React bubbles through portals), which would reopen it.
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={onKey}
              style={{
                left: pos?.left ?? 0,
                top: pos?.top ?? 0,
                maxHeight: pos?.maxHeight,
                maxWidth: pos?.maxWidth,
                visibility: pos ? 'visible' : 'hidden',
              }}
              className={cn(
                'anim-pop fixed z-popover min-w-48 overflow-auto rounded-[var(--radius)] border border-line bg-surface p-2 shadow-[var(--shadow-pop)]',
                // r17ui: a scrolling column of choices inside a popover never squeezes its rows (a
                // flex column under a max height shrinks `truncate` rows to blank slivers instead of scrolling).
                '[&_.flex-col.overflow-y-auto>*]:shrink-0 [&_.flex-col.overflow-auto>*]:shrink-0',
                className,
                sheet && SHEET,
              )}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
