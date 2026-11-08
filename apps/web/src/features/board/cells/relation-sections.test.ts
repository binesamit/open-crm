// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { pickerSections, type PickerBoard } from './relation-sections';

/** the relation picker's items under their board's name and groups, in the boards' own order. */
const clients: PickerBoard = {
  id: 'b1',
  name: 'לקוחות',
  groups: [
    { id: 'g1', title: 'פעילים', color: 'green' },
    { id: 'g2', title: 'ארכיון', color: 'grey' },
  ],
};
const projects: PickerBoard = { id: 'b2', name: 'פרויקטים', groups: [{ id: 'p1', title: 'בעבודה', color: 'blue' }] };
const hits = [
  { id: 'x', name: 'linked beyond the page', board_id: '' },
  { id: 'p', name: 'Acme Projects', board_id: 'b2', group_id: 'p1' },
  { id: 'a', name: 'אביב מור', board_id: 'b1', group_id: 'g2' },
  { id: 'b', name: 'בועז שובל', board_id: 'b1', group_id: 'g1' },
  { id: 'c', name: 'old group', board_id: 'b1', group_id: 'gone' },
];
const shape = (s: ReturnType<typeof pickerSections>) =>
  s.map((x) => [x.board?.name ?? '', x.group?.title ?? '', x.hits.map((h) => h.id).join('')]);

describe('pickerSections', () => {
  it('board and group (the default): boards in the column order, groups in the board order', () => {
    expect(shape(pickerSections(hits, [clients, projects], 'board_group'))).toEqual([
      ['', '', 'x'],
      ['לקוחות', 'פעילים', 'b'],
      ['', 'ארכיון', 'a'],
      ['', '', 'c'],
      ['פרויקטים', 'בעבודה', 'p'],
    ]);
  });

  it('by board only', () => {
    expect(shape(pickerSections(hits, [clients, projects], 'board'))).toEqual([
      ['', '', 'x'],
      ['לקוחות', '', 'abc'],
      ['פרויקטים', '', 'p'],
    ]);
  });

  it('one list as it came; one board browsed: no board title', () => {
    expect(shape(pickerSections(hits, [clients, projects], 'none'))).toEqual([['', '', 'xpabc']]);
    const browsed = hits.filter((h) => h.board_id !== 'b1');
    expect(shape(pickerSections(browsed, [projects], 'board_group'))).toEqual([
      ['', '', 'x'],
      ['', 'בעבודה', 'p'],
    ]);
  });
});
