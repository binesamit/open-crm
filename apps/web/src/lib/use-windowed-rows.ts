// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/** Lists up to this long render every row (find-in-page, keyboard and tests reach everything); longer ones a window. */
export const FULL_RENDER_ROWS = 60;

/** The scroll area of a page: the app's main panel (AppShell `.app-panel`), else the document. */
const pageScroller = (el: HTMLElement): HTMLElement =>
  el.closest<HTMLElement>('.app-panel') ?? (document.scrollingElement as HTMLElement | null) ?? document.body;

/**
 * Windowed rendering for long plain lists (members, people checklists): only the rows in view (plus `overscan`) are
 * mounted; the rest is kept as two spacers (`before` / `after` px) so the scrollbar and the layout stay true. Rows are
 * measured as they render (`measure` on each row element, with `data-index`), so differing heights are fine.
 *
 * `scroll: 'page'` — the list flows in the page and the page panel scrolls (a table on an admin page);
 * `scroll: 'self'` — the list element is its own scroll box (`max-h-… overflow-y-auto`).
 *
 * No transforms: rows stay in normal flow between the spacers, so fixed-position menus and pickers inside a row are
 * not trapped.
 */
export const useWindowedRows = <E extends HTMLElement>({
  count,
  estimate,
  getKey,
  scroll,
  overscan = 8,
  scroller: scrollerOf,
  fullRows = FULL_RENDER_ROWS,
}: {
  count: number;
  /** A row's height in px — one for all, or per row (rows of known, differing heights need no `measure`). */
  estimate: number | ((index: number) => number);
  getKey: (index: number) => string;
  scroll: 'page' | 'self';
  overscan?: number;
  /** `scroll: 'page'` — the scroll area, when it is not the page panel (e.g. the sidebar's own scroll box). */
  scroller?: (list: E) => HTMLElement | null;
  /** Lists up to this long render every row (default `FULL_RENDER_ROWS`). */
  fullRows?: number;
}) => {
  const [list, setList] = useState<E | null>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // Where the list starts inside the scroll area (the virtualiser counts from there).
  const [margin, setMargin] = useState(0);

  useLayoutEffect(() => {
    if (!list) return;
    const box = scroll === 'self' ? list : (scrollerOf?.(list) ?? pageScroller(list));
    setScroller(box);
    if (scroll === 'self') return;
    const isDoc = box === document.scrollingElement || box === document.body;
    const measure = () => {
      const top = list.getBoundingClientRect().top - (isDoc ? 0 : box.getBoundingClientRect().top) + box.scrollTop;
      setMargin((prev) => (Math.abs(prev - top) < 1 ? prev : top));
    };
    measure();
    // Anything above the list growing or shrinking (a notice, a card) moves where it starts.
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    if (box.firstElementChild) ro.observe(box.firstElementChild);
    return () => ro.disconnect();
  }, [list, scroll, scrollerOf]);

  const full = count <= fullRows;
  // eslint-disable-next-line react-hooks/incompatible-library -- the compiler skips memoising this hook
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scroller,
    estimateSize: (i) => (typeof estimate === 'number' ? estimate : estimate(i)),
    getItemKey: (i) => getKey(i),
    overscan: full ? count : overscan,
    scrollMargin: scroll === 'page' ? margin : 0,
    // Before the scroll area is known: a screen's worth of rows, not one.
    initialRect: { width: 0, height: typeof window === 'undefined' ? 800 : window.innerHeight },
  });

  const rows = virtualizer.getVirtualItems();
  const offset = scroll === 'page' ? margin : 0;
  const first = rows[0];
  const last = rows.at(-1);
  return {
    /** Callback ref for the list element (the `<tbody>` / `<ul>`; for `scroll: 'self'` also the scroll box). */
    attach: setList,
    /** The rows to render now: `index` into the source list, `key` for React. */
    rows,
    /** Spacer heights before and after the rendered rows (0 = no spacer). */
    before: first ? Math.max(0, first.start - offset) : 0,
    after: last ? Math.max(0, virtualizer.getTotalSize() - (last.end - offset)) : 0,
    /** Ref for each rendered row element (it must carry `data-index`), so real heights replace the estimate. */
    measure: virtualizer.measureElement,
    /** Whether only a window of the rows is mounted (the list is longer than `fullRows`). */
    windowed: !full,
    /** Scrolls the scroll area so that row `index` is in view (`align: 'auto'`: only when it is not). */
    scrollToIndex: (index: number) => virtualizer.scrollToIndex(index, { align: 'auto' }),
  };
};
