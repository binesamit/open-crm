// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { resolveLevel, type MenuEntry } from '@bines/ui';

/** r17ui: a choice that keeps the menu open shows its new check mark inside a submenu. */
const appearance = (palette: string): MenuEntry[] => [
  { label: 'Profile', onSelect: () => {} },
  {
    kind: 'submenu',
    label: 'Appearance',
    testId: 'menu-appearance',
    items: ['f4', 'ocean'].map((p) => ({ label: p, checked: p === palette, keepOpen: true, onSelect: () => {} })),
  },
];

describe('menu: the open submenu follows the current items', () => {
  it('finds the submenu again by its test id and returns its current entries', () => {
    const opened = appearance('f4');
    const stack = [
      { label: 'Appearance', testId: 'menu-appearance', items: (opened[1] as { items: MenuEntry[] }).items },
    ];
    const now = resolveLevel(appearance('ocean'), stack);
    expect(now.map((e) => (e.kind === undefined || e.kind === 'item' ? e.checked : null))).toEqual([false, true]);
  });

  it('by label when the submenu has no test id; the top level when nothing is open', () => {
    const items: MenuEntry[] = [{ kind: 'submenu', label: 'Sub', items: [{ label: 'x', onSelect: () => {} }] }];
    expect(resolveLevel(items, [{ label: 'Sub', items: [] }])).toHaveLength(1);
    expect(resolveLevel(items, [])).toBe(items);
  });

  it('falls back to the entries it was opened with when the submenu is gone', () => {
    const old: MenuEntry[] = [{ label: 'old', onSelect: () => {} }];
    expect(resolveLevel([], [{ label: 'Gone', items: old }])).toBe(old);
  });
});
