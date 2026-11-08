// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@bines/ui';

/**
 * a dialog rendered inside a draggable column header (or a cell) is a portal, and React events
 * bubble through portals to the component tree — selecting text in the formula field started a column drag. The
 * dialog's events stop at its root.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Dialog: events stay inside', () => {
  it('pointer, mouse, key and click events in the dialog do not reach the element that rendered it', async () => {
    const parent = {
      onPointerDown: vi.fn(),
      onMouseDown: vi.fn(),
      onKeyDown: vi.fn(),
      onClick: vi.fn(),
      onContextMenu: vi.fn(),
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host);
      root.render(
        createElement(
          'div',
          parent,
          createElement(
            Dialog,
            { open: true, onClose: vi.fn(), title: 'הגדרות עמודה' },
            createElement('textarea', { 'data-testid': 'field' }),
          ),
        ),
      );
    });
    const field = document.querySelector('[data-testid="field"]')!;
    for (const ev of [
      new PointerEvent('pointerdown', { bubbles: true }),
      new MouseEvent('mousedown', { bubbles: true }),
      new KeyboardEvent('keydown', { bubbles: true, key: ' ' }),
      new MouseEvent('click', { bubbles: true }),
      new MouseEvent('contextmenu', { bubbles: true }),
    ])
      await act(async () => field.dispatchEvent(ev));
    for (const fn of Object.values(parent)) expect(fn).not.toHaveBeenCalled();
  });
});
