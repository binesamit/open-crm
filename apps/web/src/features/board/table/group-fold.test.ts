// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { foldedWhileDragging, keepInPlace } from './group-fold';

/** Prod (round 2): every group folds while a group is dragged; the user's own folding is untouched. */
describe('foldedWhileDragging', () => {
  const sections = [
    { key: 'g1', group: { id: 'g1' } },
    { key: 'g2', group: { id: 'g2' } },
    { key: 'g3', group: { id: 'g3' } },
  ];

  it('folds every board group and keeps what was folded already', () => {
    const before = new Set(['g2']);
    expect([...foldedWhileDragging(sections, before)].sort()).toEqual(['g1', 'g2', 'g3']);
    // The given set is not changed: after the drag the table shows it again — each group as it was.
    expect([...before]).toEqual(['g2']);
  });

  it('leaves sections that are not board groups (a "group by" view, nested levels) as they are', () => {
    const grouped = [
      { key: 'status:done' },
      { key: 'g1', group: { id: 'g1' } },
      { key: 'g1>sub', group: { id: 'g1' }, level: 1 },
    ];
    expect([...foldedWhileDragging(grouped, new Set())]).toEqual(['g1']);
  });
});

describe('keepInPlace', () => {
  it('scrolls so the row keeps its height on screen, never above the top', () => {
    expect(keepInPlace(900, 200)).toBe(700);
    expect(keepInPlace(120, 300)).toBe(0);
  });
});
