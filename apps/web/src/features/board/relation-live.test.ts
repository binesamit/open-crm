// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { relationLiveScope, touchesRelationMatches } from './relation-filter';

/** r25: the relation ⚠ marks follow the linked boards live. */
const filter = {
  mode: 'filter',
  filter: { kind: 'group', operator: 'and', rules: [{ column_id: 'status', operator: 'any_of', values: ['a'] }] },
};
const columns = [
  { id: 'rel', type: 'board_relation', settings: { board_ids: ['B2', 'B3'], choice_filter: { B2: filter } } },
  {
    id: 'rel2',
    type: 'board_relation',
    settings: { board_ids: ['B2', 'B4'], choice_filter: { B2: filter, B4: filter } },
  },
  { id: 'plain', type: 'board_relation', settings: { board_ids: ['B5'] } },
  { id: 'status', type: 'status', settings: {} },
];

describe('relationLiveScope', () => {
  it('one entry per linked board with a filter, only marked columns', () => {
    expect(relationLiveScope('B1', columns)).toEqual({ columns: ['rel', 'rel2'], boards: ['B2', 'B4'] });
  });
  it('nothing to follow without filtered relation columns', () => {
    expect(relationLiveScope('B1', columns.slice(2))).toEqual({ columns: [], boards: [] });
  });
});

describe('touchesRelationMatches', () => {
  const scope = relationLiveScope('B1', columns);
  it('a change of an item on a linked board refreshes the marks', () => {
    expect(touchesRelationMatches({ type: 'cell.updated', board_id: 'B2', column_id: 'status' }, 'B1', scope)).toBe(
      true,
    );
    expect(touchesRelationMatches({ type: 'item.archived', board_id: 'B4' }, 'B1', scope)).toBe(true);
  });
  it('a link change on this board refreshes them; other cells of this board do not', () => {
    expect(touchesRelationMatches({ type: 'cell.updated', board_id: 'B1', column_id: 'rel' }, 'B1', scope)).toBe(true);
    expect(touchesRelationMatches({ type: 'cell.updated', board_id: 'B1', column_id: 'status' }, 'B1', scope)).toBe(
      false,
    );
  });
  it('unrelated boards and events do not', () => {
    expect(touchesRelationMatches({ type: 'cell.updated', board_id: 'B5', column_id: 'x' }, 'B1', scope)).toBe(false);
    expect(touchesRelationMatches({ type: 'update.created', board_id: 'B2' }, 'B1', scope)).toBe(false);
    expect(touchesRelationMatches({ type: 'ready' }, 'B1', scope)).toBe(false);
  });
  it('a resync refreshes', () => {
    expect(touchesRelationMatches({ type: 'resync' }, 'B1', scope)).toBe(true);
  });
});
