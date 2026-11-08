// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { isRowEvent, mergeRows } from '../src';

describe('live row refresh', () => {
  it('row events: item-scoped kinds with an item and a board', () => {
    expect(isRowEvent({ type: 'cell.changed', item_id: 'i', board_id: 'b' })).toBe(true);
    expect(isRowEvent({ type: 'item.created', item_id: 'i', board_id: 'b' })).toBe(true);
    expect(isRowEvent({ type: 'update.created', item_id: 'i', board_id: 'b' })).toBe(true);
    expect(isRowEvent({ type: 'cell.changed', item_id: null, board_id: 'b' })).toBe(false);
    expect(isRowEvent({ type: 'batch.applied', item_id: 'i', board_id: 'b' })).toBe(false);
    expect(isRowEvent({ type: 'column.updated', item_id: 'i', board_id: 'b' })).toBe(false);
  });

  it('replaces asked rows, drops asked rows that did not come back, appends new ones', () => {
    const rows = [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'c', v: 1 },
    ];
    const out = mergeRows(
      rows,
      ['b', 'c', 'd'],
      [
        { id: 'd', v: 2 },
        { id: 'b', v: 2 },
      ],
    );
    expect(out).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
      { id: 'd', v: 2 },
    ]);
    expect(mergeRows(rows, [], [])).toEqual(rows);
  });
});
