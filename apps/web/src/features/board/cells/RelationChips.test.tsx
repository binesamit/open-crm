// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chipLabel, chipsThatFit, RelationChips } from './RelationChips';

/**
 * a relation cell shows whole chips while they fit, then "+N"; "+N" opens the full list (open, remove
 * add); a column setting cuts each name to X characters.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('chipLabel / chipsThatFit', () => {
  it('cuts a name to the max characters (unset = whole)', () => {
    expect(chipLabel('Alphabet soup', 5)).toBe('Alpha…');
    expect(chipLabel('Short', 5)).toBe('Short');
    expect(chipLabel('Alphabet soup')).toBe('Alphabet soup');
    expect(chipLabel('אבגדהו', 3)).toBe('אבג…');
  });
  it('fits whole chips, keeping room for "+N"; at least one; all when not laid out', () => {
    // 3 chips of 50 + gaps of 4, "+N" 24: 50+4+50 = 104, +4+24 = 132 ≤ 140 → 2 fit.
    expect(chipsThatFit([50, 50, 50], 24, 140)).toBe(2);
    expect(chipsThatFit([50, 50, 50], 24, 158)).toBe(3);
    expect(chipsThatFit([200, 50], 24, 100)).toBe(1);
    expect(chipsThatFit([50, 50], 24, 0)).toBe(2);
    expect(chipsThatFit([], 24, 100)).toBe(0);
  });
});

describe('RelationChips', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    // Every chip 60px wide, the cell 140px: two chips and "+N".
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(60);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(140);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  const chips = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Bravo' },
    { id: 'c', name: 'Charlie' },
    { id: 'd', name: 'Delta' },
  ];

  it('shows the chips that fit and "+N"; "+N" lists them all to open, remove or add', () => {
    const onOpen = vi.fn();
    const onUnlink = vi.fn();
    const onAdd = vi.fn();
    act(() => root.render(createElement(RelationChips, { chips, onOpen, onUnlink, onAdd })));
    const visible = host.querySelectorAll('[data-testid="relation-chip"]');
    expect([...visible].map((b) => b.textContent)).toEqual(['Alpha']);
    const more = host.querySelector<HTMLButtonElement>('[data-testid="relation-more"]')!;
    expect(more.textContent).toBe('+3');

    act(() => more.click());
    const rows = document.querySelectorAll('[data-testid="relation-list-row"]');
    expect([...rows].map((r) => r.querySelector('button')!.textContent)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
    ]);
    act(() => rows[2]!.querySelector<HTMLButtonElement>('[data-testid="relation-list-remove"]')!.click());
    expect(onUnlink).toHaveBeenCalledWith('c');
    act(() => rows[1]!.querySelector('button')!.click());
    expect(onOpen).toHaveBeenCalledWith('b');

    act(() => more.click());
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="relation-list-add"]')!.click());
    expect(onAdd).toHaveBeenCalled();
  });

  it('read-only: the list opens items but has no remove / add', () => {
    act(() => root.render(createElement(RelationChips, { chips, onOpen: vi.fn() })));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="relation-more"]')!.click());
    expect(document.querySelectorAll('[data-testid="relation-list-row"]')).toHaveLength(4);
    expect(document.querySelector('[data-testid="relation-list-remove"]')).toBeNull();
    expect(document.querySelector('[data-testid="relation-list-add"]')).toBeNull();
  });

  it('cuts names to the max characters, the whole name in the tip; no "+N" when all fit', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    act(() => root.render(createElement(RelationChips, { chips, maxChars: 3, onOpen: vi.fn() })));
    const visible = [...host.querySelectorAll<HTMLElement>('[data-testid="relation-chip"]')];
    expect(visible.map((b) => b.textContent)).toEqual(['Alp…', 'Bra…', 'Cha…', 'Del…']);
    expect(visible[2]!.dataset.tip).toBe('Charlie');
    expect(host.querySelector('[data-testid="relation-more"]')).toBeNull();
  });

  it('round 2: one chip wider than the cell ends in "…" (it may shrink) and its tip is the full name', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(300);
    const long = [{ id: 'x', name: 'A very long linked item name that does not fit' }];
    act(() => root.render(createElement(RelationChips, { chips: long, onOpen: vi.fn() })));
    const chip = host.querySelector<HTMLElement>('[data-testid="relation-chip"]')!;
    expect(chip.className).toContain('shrink');
    expect(chip.className).toContain('truncate');
    expect(chip.dataset.last).toBe('true');
    expect(chip.dataset.tip).toBe(long[0]!.name);
    expect(host.querySelector('[data-testid="relation-more"]')).toBeNull();
  });
});
