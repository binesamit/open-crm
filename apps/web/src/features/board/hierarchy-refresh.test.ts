// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { hierarchyBoardIds, touchesHierarchy, withoutTopRows } from './hierarchy-refresh';

describe('hierarchy refresh', () => {
  it('hierarchy moves refresh the whole hierarchy; other bulk actions do not', () => {
    expect(touchesHierarchy({ type: 'move_under' })).toBe(true);
    expect(touchesHierarchy({ type: 'move_up' })).toBe(true);
    expect(touchesHierarchy({ type: 'set_cell' })).toBe(false);
    expect(touchesHierarchy(undefined)).toBe(false);
  });

  it('a board and its sub-board, from either side; a board without one is itself', () => {
    expect(hierarchyBoardIds('b', { parent_board_id: null, subitems_board_id: 's' })).toEqual(['b', 's']);
    expect(hierarchyBoardIds('s', { parent_board_id: 'b', subitems_board_id: null })).toEqual(['s', 'b']);
    expect(hierarchyBoardIds('b', { parent_board_id: null, subitems_board_id: null })).toEqual(['b']);
    expect(hierarchyBoardIds('b', undefined)).toEqual(['b']);
  });

  it('a row the board shows as an item is left out of the subitems while the caches catch up', () => {
    const subs = [{ id: 'a' }, { id: 'x' }];
    expect(withoutTopRows(subs, ['p', 'a'])).toEqual([{ id: 'x' }]);
    // Nothing shared: the same list (no new array, no re-render).
    expect(withoutTopRows(subs, ['p'])).toBe(subs);
    expect(withoutTopRows(subs, [])).toBe(subs);
  });
});
