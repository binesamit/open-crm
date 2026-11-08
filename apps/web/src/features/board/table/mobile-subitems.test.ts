// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { Item } from '../board-api';
import { canNestUnder, subRowKey, subtreeRows } from './mobile-subitems';

const it_ = (id: string, depth: number, parent: string | null = null) =>
  ({ id, name: id, depth, parent_item_id: parent, cells: {} }) as unknown as Item;

const P = it_('P', 0);
const A = it_('A', 1, 'P');
const B = it_('B', 1, 'P');
const A1 = it_('A1', 2, 'A');
const children = new Map([
  ['P', [A, B]],
  ['A', [A1]],
]);
const shape = (rows: ReturnType<typeof subtreeRows>) => rows.map((r) => `${subRowKey(r)}@${r.depth}`);

describe('r16mobsub: the subitem rows a phone shows under an open item', () => {
  it('header, the subitems, then "+ add subitem"; closed subitems stay folded', () => {
    expect(shape(subtreeRows(P, children, new Set(['P']), { depthMax: 2, canCreate: true }))).toEqual([
      'head:P@1',
      'si:A@1',
      'si:B@1',
      'add:P@1',
    ]);
  });

  it('an open subitem nests its own subitems one level further in', () => {
    expect(shape(subtreeRows(P, children, new Set(['P', 'A']), { depthMax: 2, canCreate: true }))).toEqual([
      'head:P@1',
      'si:A@1',
      'head:A@2',
      'si:A1@2',
      'add:A@2',
      'si:B@1',
      'add:P@1',
    ]);
  });

  it('respects the hierarchy depth and the create permission for "add"', () => {
    // Depth 1 only: no "add" under a subitem (its children would be level 2).
    expect(shape(subtreeRows(P, children, new Set(['P', 'A']), { depthMax: 1, canCreate: true }))).toEqual([
      'head:P@1',
      'si:A@1',
      'head:A@2',
      'si:A1@2',
      'si:B@1',
      'add:P@1',
    ]);
    expect(subtreeRows(P, children, new Set(), { depthMax: 2, canCreate: false }).some((r) => r.kind === 'add')).toBe(
      false,
    );
    // The sub-board still loading: no "add" yet.
    expect(
      subtreeRows(P, children, new Set(), { depthMax: undefined, canCreate: true }).some((r) => r.kind === 'add'),
    ).toBe(false);
  });

  it('the cards layout drops the header rows; a filtered map shows only what it keeps', () => {
    const filtered = new Map([['P', [B]]]);
    expect(shape(subtreeRows(P, filtered, new Set(['P']), { depthMax: 2, canCreate: false, head: false }))).toEqual([
      'si:B@1',
    ]);
  });

  it('never loops on a cycle in stale data', () => {
    const loop = new Map([
      ['P', [A]],
      ['A', [P]],
    ]);
    const rows = subtreeRows(P, loop, new Set(['P', 'A']), { depthMax: 5, canCreate: false });
    expect(rows.length).toBeLessThan(10);
  });

  it('canNestUnder follows the depth limit', () => {
    expect(canNestUnder({ depth: 0 }, 1, true)).toBe(true);
    expect(canNestUnder({ depth: 1 }, 1, true)).toBe(false);
    expect(canNestUnder({ depth: 1 }, 3, true)).toBe(true);
    expect(canNestUnder({ depth: 0 }, 1, false)).toBe(false);
  });
});
