// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, type RefObject } from 'react';

const NAME = 'bines-search';

/**
 * Marks the board search's matches in the table's text (13 §4.1) with the CSS Custom Highlight API — no change to
 * the cells: the text nodes are scanned, re-scanned when rows render (the list is virtual). `::highlight` is
 * styled in styles.css. Browsers without the API simply show no marks.
 */
export const useSearchHighlight = (rootRef: RefObject<HTMLElement | null>, search: string | undefined) => {
  useEffect(() => {
    const root = rootRef.current;
    const registry = typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;
    const q = search?.trim().toLocaleLowerCase();
    if (!root || !registry) return;
    if (!q) {
      registry.delete(NAME);
      return;
    }
    let frame = 0;
    const mark = () => {
      frame = 0;
      const ranges: Range[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        // Not inside fields being edited.
        acceptNode: (n) =>
          n.parentElement?.closest('input, textarea') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.toLocaleLowerCase() ?? '';
        for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
          const r = new Range();
          r.setStart(node, i);
          r.setEnd(node, i + q.length);
          ranges.push(r);
        }
      }
      registry.set(NAME, new Highlight(...ranges));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(mark);
    };
    mark();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      registry.delete(NAME);
    };
  }, [rootRef, search]);
};
