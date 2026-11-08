// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/toast', () => ({ showToast: vi.fn() }));

const { revealNewItem } = await import('./reveal-new-item');

/**
 * a new item on a computed-name board shows in its row (no card) and the cell of the name's first
 * source column becomes the grid's active cell, so typing fills it.
 */
const row = (itemId: string) => {
  const el = document.createElement('div');
  el.dataset.testid = 'item-row';
  el.dataset.itemId = itemId;
  el.innerHTML =
    '<div data-cell="0" data-column="status"></div><div data-cell="1" data-column="client"></div>' +
    '<div data-cell="2" data-column="city"></div>';
  return el;
};
const frames = () => new Promise((r) => setTimeout(r, 50));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('revealNewItem', () => {
  it('activates the cell of the given column once the row is rendered', async () => {
    const setActive = vi.fn();
    revealNewItem('i1', 'item', { columnKey: 'client', setActive });
    await frames();
    expect(setActive).not.toHaveBeenCalled(); // not rendered yet: it keeps looking
    document.body.appendChild(row('i1'));
    await frames();
    expect(setActive).toHaveBeenCalledExactlyOnceWith(1);
    expect(document.querySelector('[data-item-id="i1"]')!.classList.contains('row-fresh')).toBe(true);
  });

  it('a column the row does not show activates nothing (the row is still revealed)', async () => {
    const setActive = vi.fn();
    document.body.appendChild(row('i2'));
    revealNewItem('i2', 'item', { columnKey: 'hidden', setActive });
    await frames();
    expect(setActive).not.toHaveBeenCalled();
    expect(document.querySelector('[data-item-id="i2"]')!.classList.contains('row-fresh')).toBe(true);
  });
});
