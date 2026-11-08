// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

/**
 * Round 12 ("whenever the system pops up a panel or anything that goes off the screen and suddenly can't be
 * seen — move it toward the screen, not out"). One placement rule for every floating element — menus, popovers,
 * cell editors, the @mention and "/" suggestion lists, the time picker, the icon picker: open on the preferred
 * side of the anchor; flip to the other side when it does not fit there and the other side has more room; line up
 * with the anchor's inline-start edge (the right edge in RTL), else its other edge; and finally shift back inside
 * the bounds. The bounds are the viewport less a margin, narrowed to a container when one is given (the item card,
 * a side panel) — unless the container is too small for the panel, then the viewport.
 */
export type Box = { left: number; top: number; right: number; bottom: number };

export type FloatingOptions = {
  /** Preferred side: below (default) or above the anchor. */
  side?: 'bottom' | 'top';
  /** Which anchor edge the panel lines up with: inline-start (default), inline-end, or centred. */
  align?: 'start' | 'end' | 'center';
  rtl?: boolean;
  /** Space between the anchor and the panel. */
  gap?: number;
  /** Space kept from the viewport's edges. */
  margin?: number;
  /** A container the panel should stay in (the item card); ignored when the panel cannot fit in it. */
  boundary?: Box | null;
};

export type Placement = {
  left: number;
  top: number;
  side: 'bottom' | 'top';
  /** Room on the chosen side — a taller panel scrolls. */
  maxHeight: number;
  maxWidth: number;
};

/**  held between  and . */
export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));

export const placeFloating = (
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  o: FloatingOptions = {},
): Placement => {
  const margin = o.margin ?? 8;
  const gap = o.gap ?? 4;
  const screen: Box = { left: margin, top: margin, right: viewport.width - margin, bottom: viewport.height - margin };
  const inner = o.boundary
    ? {
        left: Math.max(screen.left, o.boundary.left + 4),
        top: Math.max(screen.top, o.boundary.top + 4),
        right: Math.min(screen.right, o.boundary.right - 4),
        bottom: Math.min(screen.bottom, o.boundary.bottom - 4),
      }
    : screen;
  // Horizontally the container counts only when the panel fits in it; vertically the screen decides.
  const h = inner.right - inner.left >= size.width ? inner : screen;

  // Vertical: the preferred side, or the other one when it has more room and the panel does not fit.
  const below = screen.bottom - anchor.bottom - gap;
  const above = anchor.top - gap - screen.top;
  const want = o.side ?? 'bottom';
  const fits = (s: 'bottom' | 'top') => size.height <= (s === 'bottom' ? below : above);
  const other = want === 'bottom' ? 'top' : 'bottom';
  const side = fits(want) || (!fits(other) && (want === 'bottom' ? below >= above : above >= below)) ? want : other;
  const room = Math.max(0, side === 'bottom' ? below : above);
  const height = Math.min(size.height, room);
  const top =
    side === 'bottom'
      ? clamp(anchor.bottom + gap, screen.top, Math.max(screen.top, screen.bottom - height))
      : clamp(anchor.top - gap - height, screen.top, Math.max(screen.top, screen.bottom - height));

  // Horizontal: the logical edge (RTL: start = right), the other edge when that overflows, then shift inside.
  const startLeft = o.rtl ? anchor.right - size.width : anchor.left;
  const endLeft = o.rtl ? anchor.left : anchor.right - size.width;
  const centre = (anchor.left + anchor.right) / 2 - size.width / 2;
  const inside = (x: number) => x >= h.left && x + size.width <= h.right;
  const align = o.align ?? 'start';
  let left = align === 'center' ? centre : align === 'start' ? startLeft : endLeft;
  if (!inside(left) && align !== 'center') {
    const flipped = align === 'start' ? endLeft : startLeft;
    if (inside(flipped)) left = flipped;
  }
  left = size.width >= h.right - h.left ? h.left : clamp(left, h.left, h.right - size.width);
  return { left, top, side, maxHeight: room, maxWidth: screen.right - screen.left };
};

/**
 * pal40: a big panel (a status picker with many labels in columns) does not hang off a small cell
 * it floats beside the centre of the viewport: centred across; centred down too unless that would cover the anchor,
 * then as near the middle as the larger band above or below the anchor allows, its height capped to that band (it
 * scrolls inside). Never wider than the viewport less the margins (it scrolls across inside). No backdrop: the page
 * still scrolls, and the anchor stays in sight.
 */
export const placeCentred = (
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  o: { margin?: number; gap?: number } = {},
): Placement => {
  const margin = o.margin ?? 8;
  const gap = o.gap ?? 8;
  const maxWidth = Math.max(0, viewport.width - 2 * margin);
  const width = Math.min(size.width, maxWidth);
  const left = Math.max(margin, Math.round((viewport.width - width) / 2));
  const full = Math.max(0, viewport.height - 2 * margin);
  const height = Math.min(size.height, full);
  const middle = Math.max(margin, Math.round((viewport.height - height) / 2));
  const acrossAnchor = left < anchor.right && left + width > anchor.left;
  const covers = (top: number, h: number) => acrossAnchor && top < anchor.bottom + gap && top + h > anchor.top - gap;
  if (!covers(middle, height))
    return { left, top: middle, side: middle >= anchor.bottom ? 'bottom' : 'top', maxHeight: full, maxWidth };
  const below = viewport.height - margin - (anchor.bottom + gap);
  const above = anchor.top - gap - margin;
  const side = below >= above ? 'bottom' : 'top';
  const room = Math.max(0, side === 'bottom' ? below : above);
  const h = Math.min(size.height, room);
  const bandTop = side === 'bottom' ? anchor.bottom + gap : margin;
  const bandBottom = side === 'bottom' ? viewport.height - margin : anchor.top - gap;
  const top = clamp(Math.round((viewport.height - h) / 2), bandTop, Math.max(bandTop, bandBottom - h));
  return { left, top, side, maxHeight: room, maxWidth };
};

const toBox = (r: DOMRect | Box): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

/** The container a floating element should stay in: the nearest dialog / side panel around `el`, if any. */
export const floatingBoundary = (el: Element | null | undefined): Box | null => {
  const host = el?.closest('[data-float-boundary], [role="dialog"]');
  return host ? toBox(host.getBoundingClientRect()) : null;
};

const isRtl = (el: Element | null | undefined) =>
  (el ? getComputedStyle(el).direction : document.documentElement.dir) === 'rtl';

/**
 * Places `floating` against `anchor()` (an element or a rect — a caret, a point) with `placeFloating`, and keeps it
 * placed while the page scrolls, the window resizes or the panel changes size. Returns the style to spread on the
 * fixed panel (hidden until placed) and the placement. `key` re-places when the anchor moves (the caret's rect).
 */
export const useFloating = ({
  open,
  floating,
  anchor,
  boundary,
  key,
  ...options
}: Omit<FloatingOptions, 'boundary' | 'rtl'> & {
  open: boolean;
  floating: RefObject<HTMLElement | null>;
  anchor: () => Element | DOMRect | Box | null | undefined;
  /** The container (default: none); `floatingBoundary(el)` finds the item card / dialog around an element. */
  boundary?: () => Box | null;
  rtl?: boolean;
  key?: unknown;
}): { style: CSSProperties; placement: Placement | null } => {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const { side, align, gap, margin, rtl } = options;
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const place = () => {
      const el = floating.current;
      const a = anchor();
      if (!el || !a) return;
      const rect = a instanceof Element ? a.getBoundingClientRect() : a;
      const { width, height } = el.getBoundingClientRect();
      const next = placeFloating(
        toBox(rect),
        // scrollHeight: a panel already capped by an earlier maxHeight still wants its full height.
        { width, height: Math.max(height, el.scrollHeight) },
        { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight },
        {
          side,
          align,
          gap,
          margin,
          rtl: rtl ?? isRtl(a instanceof Element ? a : null),
          boundary: boundary?.() ?? null,
        },
      );
      setPlacement((prev) =>
        prev &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.maxHeight === next.maxHeight &&
        prev.side === next.side
          ? prev
          : next,
      );
    };
    place();
    const el = floating.current;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (el) observer?.observe(el);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
    // `anchor` / `boundary` are read when placing; `key` says the anchor moved.
  }, [open, key, side, align, gap, margin, rtl]);
  return {
    placement,
    style: placement
      ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight, maxWidth: placement.maxWidth }
      : { left: 0, top: 0, visibility: 'hidden' },
  };
};
