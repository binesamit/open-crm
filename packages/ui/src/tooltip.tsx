// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';

/**
 * The system tooltip (product fix list, fix6): every hover explanation is ours, never the browser's native one.
 * `<TooltipHost />` is mounted once at the app root and needs no call-site changes: any element with a `title`
 * (or a `data-tip`, for code that wants the system tooltip directly) shows one styled bubble.
 *
 * - On the first hover / focus the `title` moves to `data-tip` (so the native tooltip never shows); `data-tip`
 *   is the source of truth from then on. An element left without an accessible name gets the text as its
 *   `aria-label`, so icon buttons keep their name; elements that already have a name are not touched.
 * - One listener set on the document and a single bubble element: no per-element React state.
 * - Shows after a short hover (at once on keyboard focus, or when moving between tipped elements), hides on
 *   pointer out / blur / scroll / Esc / pointer down. Multi-line text (`\n`) is kept.
 */

export const TOOLTIP_ID = 'system-tooltip';
const SHOW_DELAY = 400;
/** After a tooltip closes because the pointer moved away, the next one within this window opens at once. */
const WARM_MS = 300;
const GAP = 6;
const MARGIN = 8;
const SELECTOR = '[title],[data-tip]';

/** Whether the element would still have an accessible name without its `title`. */
const hasAccessibleName = (el: Element) => {
  if (el.getAttribute('aria-label')?.trim() || el.hasAttribute('aria-labelledby')) return true;
  if (el instanceof HTMLImageElement) return !!el.alt;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return !!el.labels?.length || ('placeholder' in el && !!el.placeholder);
  }
  return !!el.textContent?.trim();
};

/** Moves a native `title` to `data-tip` (the native tooltip never shows). */
const adopt = (el: Element) => {
  const title = el.getAttribute('title');
  if (title === null) return;
  if (!hasAccessibleName(el) && title.trim()) el.setAttribute('aria-label', title.replace(/\s*\n\s*/g, ' ').trim());
  el.removeAttribute('title');
  el.setAttribute('data-tip', title);
};

const tipOf = (el: Element) => el.getAttribute('data-tip')?.trim() ?? '';

/** Places the bubble above the element; below, then beside it (reading direction first) when it does not fit. */
const place = (tip: HTMLElement, el: Element) => {
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, vw - MARGIN - w));
  const clampY = (y: number) => Math.max(MARGIN, Math.min(y, vh - MARGIN - h));
  const cx = clampX(r.left + r.width / 2 - w / 2);
  let x = cx;
  let y = r.top - GAP - h;
  let side = 'top';
  if (y < MARGIN) {
    y = r.bottom + GAP;
    side = 'bottom';
    if (y + h > vh - MARGIN) {
      // Neither above nor below: beside it, on the side the text reads towards when it fits.
      const rtl = (el.closest('[dir]')?.getAttribute('dir') ?? document.documentElement.dir) === 'rtl';
      const before = r.left - GAP - w;
      const after = r.right + GAP;
      const fitsBefore = before >= MARGIN;
      const fitsAfter = after + w <= vw - MARGIN;
      x = rtl ? (fitsBefore || !fitsAfter ? before : after) : fitsAfter || !fitsBefore ? after : before;
      x = clampX(x);
      y = clampY(r.top + r.height / 2 - h / 2);
      side = 'side';
    }
  }
  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(y)}px`;
  tip.dataset.side = side;
};

/** Mounted once at the app root; renders nothing itself (the bubble lives on <body>, above every layer). */
export const TooltipHost = () => {
  useEffect(() => {
    const tip = document.createElement('div');
    tip.id = TOOLTIP_ID;
    tip.className = 'sys-tip';
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('data-testid', 'system-tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);

    let current: Element | null = null; // the element the tooltip is for (pending or shown)
    let shown = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watch: ReturnType<typeof setInterval> | undefined;
    let hiddenAt = 0;
    let prevDescribedBy: string | null = null;

    const observer = new MutationObserver(() => {
      if (!current) return;
      // A re-render put a (new) title back: adopt it again and follow the text.
      adopt(current);
      const text = tipOf(current);
      if (!text) return hide();
      if (shown && tip.textContent !== text) {
        tip.textContent = text;
        place(tip, current);
      }
    });

    const show = () => {
      timer = undefined;
      const el = current;
      if (!el || !el.isConnected) return hide();
      const text = tipOf(el);
      if (!text) return hide();
      tip.textContent = text;
      tip.dir = el.closest('[dir]')?.getAttribute('dir') ?? document.documentElement.dir;
      tip.hidden = false;
      place(tip, el);
      if (!shown) {
        prevDescribedBy = el.getAttribute('aria-describedby');
        el.setAttribute('aria-describedby', prevDescribedBy ? `${prevDescribedBy} ${TOOLTIP_ID}` : TOOLTIP_ID);
      }
      shown = true;
      // The element can leave the DOM under the pointer (a re-render) without a pointerout.
      watch ??= setInterval(() => {
        if (current && !current.isConnected) hide();
      }, 500);
    };

    function hide() {
      clearTimeout(timer);
      timer = undefined;
      clearInterval(watch);
      watch = undefined;
      observer.disconnect();
      if (current && shown) {
        if (prevDescribedBy) current.setAttribute('aria-describedby', prevDescribedBy);
        else current.removeAttribute('aria-describedby');
        hiddenAt = performance.now();
      }
      prevDescribedBy = null;
      current = null;
      shown = false;
      tip.hidden = true;
    }

    const open = (el: Element, now: boolean) => {
      if (el === current) return;
      hide();
      adopt(el);
      if (!tipOf(el)) return;
      current = el;
      observer.observe(el, { attributes: true, attributeFilter: ['title', 'data-tip'] });
      if (now || performance.now() - hiddenAt < WARM_MS) show();
      else timer = setTimeout(show, SHOW_DELAY);
    };

    const onOver = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.(SELECTOR);
      if (!el) return;
      if (e.pointerType === 'touch') {
        adopt(el); // no hover bubbles on touch; just keep the native one away
        return;
      }
      open(el, false);
    };
    const onOut = (e: PointerEvent) => {
      if (!current) return;
      const to = e.relatedTarget as Node | null;
      if (to && current.contains(to)) return;
      hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Element | null;
      const el = target?.closest?.(SELECTOR);
      if (!el) return;
      let keyboard = false;
      try {
        keyboard = target!.matches(':focus-visible');
      } catch {
        keyboard = false;
      }
      if (keyboard) open(el, true);
      else adopt(el);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (current && current.contains(e.target as Node)) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && current) hide();
    };
    const onDismiss = () => {
      if (current) hide();
    };

    // Disabled controls may not get pointer events themselves (the event lands on their parent): find a tipped
    // disabled child under the pointer — only for direct children, and at most once a frame.
    let frame = 0;
    let last: PointerEvent | null = null;
    const probe = () => {
      frame = 0;
      const e = last;
      if (!e || current) return;
      const parent = e.target as Element | null;
      if (!parent?.matches?.(':has(> :disabled:is([title],[data-tip]))')) return;
      const el = document
        .elementsFromPoint(e.clientX, e.clientY)
        .find((x) => x.parentElement === parent && x.matches(':disabled') && x.matches(SELECTOR));
      if (el) open(el, false);
    };
    const onMove = (e: PointerEvent) => {
      if (current || e.pointerType === 'touch') return;
      last = e;
      frame ||= requestAnimationFrame(probe);
    };

    const opts = { capture: true, passive: true } as const;
    document.addEventListener('pointerover', onOver, opts);
    document.addEventListener('pointerout', onOut, opts);
    document.addEventListener('pointermove', onMove, opts);
    document.addEventListener('pointerdown', onDismiss, opts);
    document.addEventListener('focusin', onFocusIn, opts);
    document.addEventListener('focusout', onFocusOut, opts);
    document.addEventListener('keydown', onKey, opts);
    document.addEventListener('scroll', onDismiss, opts);
    window.addEventListener('resize', onDismiss, opts);
    window.addEventListener('blur', onDismiss);
    return () => {
      hide();
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerover', onOver, opts);
      document.removeEventListener('pointerout', onOut, opts);
      document.removeEventListener('pointermove', onMove, opts);
      document.removeEventListener('pointerdown', onDismiss, opts);
      document.removeEventListener('focusin', onFocusIn, opts);
      document.removeEventListener('focusout', onFocusOut, opts);
      document.removeEventListener('keydown', onKey, opts);
      document.removeEventListener('scroll', onDismiss, opts);
      window.removeEventListener('resize', onDismiss, opts);
      window.removeEventListener('blur', onDismiss);
      tip.remove();
    };
  }, []);
  return null;
};
