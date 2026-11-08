// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { Column, Item } from '../board-api';
import { bulkHoverRule, bulkLinks, bulkSettable, bulkTargets, linkDelta, withCell, withLinkDelta } from './bulk-cells';

describe('a relation toggle in a checked row', () => {
  it('relation columns join the checked-rows edit (not read-only ones)', () => {
    expect(bulkLinks(col('board_relation'))).toBe(true);
    expect(bulkLinks(col('board_relation', { read_only: true }))).toBe(false);
    expect(bulkLinks(col('status'))).toBe(false);
  });
  it('the toggle becomes add / remove, applied to each row’s own links', () => {
    const d = linkDelta({ item_ids: ['y'] }, { item_ids: ['y', 'x'] });
    expect(d).toEqual({ add: ['x'], remove: [] });
    expect(withLinkDelta({ item_ids: ['z'] }, d)).toEqual({ item_ids: ['z', 'x'] });
    expect(withLinkDelta(null, d)).toEqual({ item_ids: ['x'] });
    const off = linkDelta({ item_ids: ['x'] }, null);
    expect(off).toEqual({ add: [], remove: ['x'] });
    expect(withLinkDelta({ item_ids: ['x'] }, off)).toBeNull();
    // A single-link column replaces.
    expect(withLinkDelta({ item_ids: ['z'] }, { add: ['x'], remove: [] }, false)).toEqual({ item_ids: ['x'] });
  });
});

const sel = (ids: string[]) => ({ ids, has: (id: string) => ids.includes(id) });
const col = (type: string, extra: Partial<Column> = {}) => ({ id: 'c1', type, read_only: false, ...extra }) as Column;

describe('round 12: an edit in a checked row applies to all the checked rows', () => {
  it('applies only to a row among 2+ checked rows', () => {
    expect(bulkTargets(sel(['a', 'b']), 'a')).toEqual(['a', 'b']);
    expect(bulkTargets(sel(['a', 'b']), 'c')).toBeNull(); // an unchecked row edits itself
    expect(bulkTargets(sel(['a']), 'a')).toBeNull(); // one checked row = a normal edit
    expect(bulkTargets(null, 'a')).toBeNull();
  });

  it('uses the batch rule for columns (no read-only, files, time, links)', () => {
    expect(bulkSettable(col('status'))).toBe(true);
    expect(bulkSettable(col('text'))).toBe(true);
    expect(bulkSettable(col('people'))).toBe(true);
    expect(bulkSettable(col('date'))).toBe(true);
    expect(bulkSettable(col('status', { read_only: true }))).toBe(false);
    expect(bulkSettable(col('name'))).toBe(false);
    expect(bulkSettable(col('file'))).toBe(false);
    expect(bulkSettable(col('time_tracking'))).toBe(false);
  });

  it('patches the value at once and clears it on null', () => {
    const item = { id: 'a', cells: { c1: { value: 1, text: '1' }, c2: { value: 'x', text: 'x' } } } as unknown as Item;
    expect(withCell(item, 'c1', 5).cells.c1).toEqual({ value: 5, text: '1' });
    expect(withCell(item, 'c3', 'n').cells.c3).toEqual({ value: 'n', text: null });
    expect(withCell(item, 'c1', null).cells.c1).toBeUndefined();
    expect(item.cells.c1!.value).toBe(1); // not mutated
  });

  it('lights one column of the checked rows of one board', () => {
    expect(bulkHoverRule('B1', 'status')).toContain('[data-bulk-board="B1"][data-selected] > [data-column="status"]');
    expect(bulkHoverRule('B1', 'a"b')).toContain('[data-column="a\\"b"]');
  });
});
