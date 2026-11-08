// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phone board (product owner: "the filter line just takes a row, the description gets in the way"): above
 * the rows only the views dropdown and the save bar remain; the active conditions are listed in
 * the tools sheet (each removable, plus "clear all"), the badge on the filter icon counts them.
 */
const { MobileBoardLead, MobileToolsButton } = await import('./MobileBoardBar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});
const render = (el: React.ReactElement) => {
  root = createRoot(host);
  act(() => root!.render(el));
};
const byTestId = (id: string) => document.querySelectorAll(`[data-testid="${id}"]`);

const conditions = [
  { key: '0', label: 'תת-פריט: סטטוס: אינו הושלם' },
  { key: '1', label: 'קבוצה: אינו ארכיון' },
];

describe('MobileBoardLead', () => {
  it('shows only the views and the save bar — no description, no condition chips', () => {
    render(
      createElement(MobileBoardLead, {
        views: createElement('div', { 'data-testid': 'views' }),
        children: createElement('div', { 'data-testid': 'save' }),
      }),
    );
    expect(byTestId('mobile-board-lead')).toHaveLength(1);
    expect(byTestId('views')).toHaveLength(1);
    expect(byTestId('save')).toHaveLength(1);
    expect(byTestId('mobile-filter-chips')).toHaveLength(0);
    expect(byTestId('board-description')).toHaveLength(0);
  });

  it('renders nothing when there is nothing to show', () => {
    render(createElement(MobileBoardLead, {}));
    expect(byTestId('mobile-board-lead')).toHaveLength(0);
  });
});

describe('MobileToolsButton', () => {
  const tools = (open: boolean, onClear = vi.fn(), onClearAll = vi.fn()) =>
    createElement(MobileToolsButton, {
      count: conditions.length,
      active: false,
      open,
      setOpen: vi.fn(),
      conditions,
      onClear,
      onClearAll,
      children: createElement('div', { 'data-testid': 'tools' }),
    });

  it('counts the conditions on the badge; nothing listed while the sheet is closed', () => {
    render(tools(false));
    expect(byTestId('mobile-filter-count')[0]?.textContent).toBe('2');
    expect(byTestId('mobile-filter-chip')).toHaveLength(0);
  });

  it('lists the conditions in the sheet: ✕ removes one, "clear all" removes every one', () => {
    const onClear = vi.fn();
    const onClearAll = vi.fn();
    render(tools(true, onClear, onClearAll));
    const active = byTestId('mobile-filter-active')[0]!;
    expect(active.querySelectorAll('[data-testid="mobile-filter-chip"]')).toHaveLength(2);
    expect(active.textContent).toContain('קבוצה: אינו ארכיון');
    act(() => (active.querySelectorAll('[data-testid="mobile-filter-chip-clear"]')[1] as HTMLElement).click());
    expect(onClear).toHaveBeenCalledWith('1');
    act(() => (byTestId('mobile-filter-clear-all')[0] as HTMLElement).click());
    expect(onClearAll).toHaveBeenCalledOnce();
    // The tools follow the list.
    expect(byTestId('tools')).toHaveLength(1);
  });

  it('no list without active conditions', () => {
    render(
      createElement(MobileToolsButton, {
        count: 0,
        active: true,
        open: true,
        setOpen: vi.fn(),
        children: createElement('div', { 'data-testid': 'tools' }),
      }),
    );
    expect(byTestId('mobile-filter-active')).toHaveLength(0);
    expect(byTestId('tools')).toHaveLength(1);
  });
});
