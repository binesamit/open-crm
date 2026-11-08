// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, type RefObject } from 'react';

/**
 * r25 (product owner: "scrolling back toward the start, the name column widens by
 * itself"): the phone table's sticky name column follows the sideways scroll. At the start (scroll 0) it is wide
 * (`fullNameWidth`, names on two lines); scrolling toward the other columns narrows it to `NAME_MIN` (more data
 * columns in view, the name truncated); scrolling back widens it again, smoothly. The width is a CSS variable
 * (`--m-name-w`) on the table, set from a passive scroll listener once per frame — no React render per frame —
 * and the rows keep their fixed height, so nothing jumps.
 */
export const NAME_MIN = 110;
/** The name column at the start: 65% of the screen, at least 140px, at most 320px (a tablet). */
export const fullNameWidth = (viewport: number) => Math.round(Math.min(320, Math.max(140, viewport * 0.65)));
/** Under this width the name shows one truncated line instead of two. */
export const NARROW_AT = 150;

/**
 * How a browser reports `scrollLeft` in a right-to-left scroller: `negative` (the spec, today's browsers: 0 at the
 * start, negative toward the end), `reverse` (0 at the start, positive toward the end) or `default` (old Chrome:
 * the maximum at the start, 0 at the end).
 */
export type RtlScroll = 'negative' | 'reverse' | 'default';

/** The distance scrolled from the inline start, whatever the direction and the browser. */
export const scrollFromStart = (scrollLeft: number, maxScroll: number, rtl: boolean, type: RtlScroll = 'negative') => {
  if (!rtl) return Math.max(0, scrollLeft);
  if (type === 'default') return Math.max(0, maxScroll - scrollLeft);
  return Math.abs(scrollLeft);
};

/**
 * The name column's width at `fromStart` px from the start: `full` shrinking 1:1 (× `k`) with the scroll down to
 * `min`. `overflow` = how far the table scrolls with the name at full width: the shrink never exceeds what the
 * scroll can still reach, so a narrower table never shortens the scroll under the finger (no bounce at the end).
 */
export const nameWidth = ({
  fromStart,
  full,
  min = NAME_MIN,
  overflow = Infinity,
  k = 1,
}: {
  fromStart: number;
  full: number;
  min?: number;
  overflow?: number;
  k?: number;
}) => {
  const range = Math.max(0, Math.min(full - min, (k * Math.max(0, overflow)) / (1 + k)));
  return full - Math.min(range, Math.max(0, fromStart) * k);
};

let rtlType: RtlScroll | null = null;
/** Probes once how this browser reports a right-to-left `scrollLeft`. */
export const detectRtlScroll = (): RtlScroll => {
  if (rtlType) return rtlType;
  const outer = document.createElement('div');
  outer.dir = 'rtl';
  outer.style.cssText = 'position:absolute;top:-1000px;width:4px;height:1px;overflow:scroll;visibility:hidden';
  const inner = document.createElement('div');
  inner.style.cssText = 'width:8px;height:1px';
  outer.appendChild(inner);
  document.body.appendChild(outer);
  if (outer.scrollLeft > 0) rtlType = 'default';
  else {
    outer.scrollLeft = 1;
    rtlType = outer.scrollLeft === 0 ? 'negative' : 'reverse';
  }
  outer.remove();
  return rtlType;
};

const scrollParent = (el: HTMLElement | null) => {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const { overflowX } = getComputedStyle(p);
    if (overflowX === 'auto' || overflowX === 'scroll') return p;
  }
  return null;
};

/** Drives `--m-name-w` (and `data-narrow`) on the phone table from its scroller's sideways scroll. */
export const useScrollNameWidth = (ref: RefObject<HTMLElement | null>) => {
  useLayoutEffect(() => {
    const table = ref.current;
    const scroller = scrollParent(table);
    if (!table || !scroller) return;
    let frame = 0;
    let width = 0;
    const apply = () => {
      frame = 0;
      const full = fullNameWidth(document.documentElement.clientWidth || window.innerWidth);
      const rtl = getComputedStyle(scroller).direction === 'rtl';
      const max = scroller.scrollWidth - scroller.clientWidth;
      const fromStart = scrollFromStart(scroller.scrollLeft, max, rtl, rtl ? detectRtlScroll() : 'negative');
      // The scroll reach with the name at full width (the table is narrower by what the name gave up).
      const overflow = max + (width ? full - width : 0);
      const next = Math.round(nameWidth({ fromStart, full, overflow }));
      if (next === width) return;
      width = next;
      table.style.setProperty('--m-name-w', `${next}px`);
      table.toggleAttribute('data-narrow', next < NARROW_AT);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    const observer = new ResizeObserver(onScroll);
    observer.observe(table);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      observer.disconnect();
    };
  }, [ref]);
};
