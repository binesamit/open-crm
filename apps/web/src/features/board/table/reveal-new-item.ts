// SPDX-License-Identifier: AGPL-3.0-only
import { t, type MessageKey } from '@bines/shared';
import { showToast } from '../../../lib/toast';
import { scrollBehavior } from '@bines/ui';

/** How long to wait for the new row to render (the create's cache update, then React's commit). */
const WAIT_MS = 2000;

/**
 * r27 (product owner: "just create it, don't open the card"): after a one-tap add on the phone, the new row is
 * scrolled into view and lit briefly (`row-fresh`), and a small toast says it was added. The card is not opened —
 * a tap on the name opens it.
 */
export const revealNewItem = (
  itemId: string,
  kind: 'item' | 'subitem' = 'item',
  /**
   * Prod (computed names, the table): the cell of this column becomes the grid's active cell once the
   * row is rendered, so typing fills the name's first source column.
   */
  activate?: { columnKey: string; setActive: (col: number) => void },
) => {
  showToast({
    message: t((kind === 'item' ? 'r27.mobile.itemAdded' : 'r27.mobile.subitemAdded') as MessageKey),
    seconds: 3,
  });
  const started = performance.now();
  const find = () => {
    const id = CSS.escape(itemId);
    const el = document.querySelector<HTMLElement>(
      ['item-row', 'item-tile', 'card-subitem'].map((tid) => `[data-testid="${tid}"][data-item-id="${id}"]`).join(','),
    );
    if (el) {
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: scrollBehavior() });
      el.classList.remove('row-fresh');
      void el.offsetWidth;
      el.classList.add('row-fresh');
      el.dataset.justAdded = 'true';
      setTimeout(() => {
        el.classList.remove('row-fresh');
        delete el.dataset.justAdded;
      }, 1500);
      if (activate) {
        const cell = el.querySelector<HTMLElement>(`[data-column="${CSS.escape(activate.columnKey)}"][data-cell]`);
        const col = Number(cell?.dataset.cell);
        if (cell && Number.isInteger(col)) activate.setActive(col);
      }
      return;
    }
    if (performance.now() - started < WAIT_MS) requestAnimationFrame(find);
  };
  requestAnimationFrame(find);
};
