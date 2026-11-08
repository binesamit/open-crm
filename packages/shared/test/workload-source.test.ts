// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  aggregateWorkload,
  numbersSettingsSchema,
  remapViewSettings,
  viewSettingsSchema,
  workloadRowLabel,
  workloadSourceRows,
} from '../src';

/** Round 15 (r15dash): the workload view's source (items / subitems / both) and the widgets' `source`. */
type Row = { id: string; name: string; parent_item_id: string | null };
const items: Row[] = [
  { id: 'a', name: 'Alpha', parent_item_id: null },
  { id: 'b', name: 'Beta', parent_item_id: null },
];
const subitems: Row[] = [
  { id: 'a1', name: 'Design', parent_item_id: 'a' },
  { id: 'a1x', name: 'Sketch', parent_item_id: 'a1' }, // a sub-subitem
  { id: 'b1', name: 'Build', parent_item_id: 'b' },
  { id: 'c1', name: 'Hidden', parent_item_id: 'c' }, // its item is not in the view
];

describe('workloadSourceRows', () => {
  it('items: the view’s items only', () => {
    const rows = workloadSourceRows('items', items, subitems);
    expect(rows.map((r) => [r.row.id, r.kind])).toEqual([
      ['a', 'item'],
      ['b', 'item'],
    ]);
  });

  it('subitems: every depth, only under items the view shows, each with its direct parent', () => {
    const rows = workloadSourceRows('subitems', items, subitems);
    expect(rows.map((r) => [r.row.id, r.parent?.id])).toEqual([
      ['a1', 'a'],
      ['a1x', 'a1'],
      ['b1', 'b'],
    ]);
    expect(rows.every((r) => r.kind === 'subitem')).toBe(true);
  });

  it('a filtered view narrows the subitems too', () => {
    const rows = workloadSourceRows('subitems', [items[1]!], subitems);
    expect(rows.map((r) => r.row.id)).toEqual(['b1']);
  });

  it('both: items first, then their subitems', () => {
    expect(workloadSourceRows('both', items, subitems).map((r) => r.row.id)).toEqual(['a', 'b', 'a1', 'a1x', 'b1']);
  });

  it('labels a subitem under its parent’s name', () => {
    const rows = workloadSourceRows('both', items, subitems);
    expect(rows.map(workloadRowLabel)).toEqual(['Alpha', 'Beta', 'Alpha › Design', 'Design › Sketch', 'Beta › Build']);
  });

  it('subitem rows feed the same aggregation (each carries its own people and dates)', () => {
    const rows = workloadSourceRows('subitems', items, subitems);
    const people: Record<string, string[]> = { a1: ['u1'], a1x: ['u1'], b1: ['u2'] };
    const grid = aggregateWorkload({
      items: rows.map((r) => ({
        id: r.row.id,
        people: people[r.row.id] ?? [],
        span: { from: '2026-10-05', to: '2026-10-05' },
        effort: null,
      })),
      measure: 'count',
      unit: 'day',
      range: { from: '2026-10-04', to: '2026-10-10' },
      weekend: 'fri_sat',
      firstDay: 0,
    });
    expect(grid.get('u1')?.get('2026-10-05')).toEqual({ load: 2, items: ['a1', 'a1x'] });
    expect(grid.get('u2')?.get('2026-10-05')?.load).toBe(1);
  });
});

describe('settings', () => {
  it('a workload view reads its items unless told otherwise; a copy to another board drops sub-board columns', () => {
    const s = viewSettingsSchema.parse({ workload: { people_column_id: 'owner', sub_people_column_id: 'person' } });
    expect(s.workload?.source).toBe('items');
    const copy = remapViewSettings({ ...s, workload: { ...s.workload!, source: 'both' } }, (k) => k);
    expect(copy.workload).toMatchObject({ source: 'both', people_column_id: 'owner' });
    expect(copy.workload?.sub_people_column_id).toBeUndefined();
  });

  it('a widget reads items by default; subitems or both on request', () => {
    expect(numbersSettingsSchema.parse({}).source).toBe('items');
    expect(numbersSettingsSchema.parse({ source: 'both' }).source).toBe('both');
    expect(numbersSettingsSchema.safeParse({ source: 'parents' }).success).toBe(false);
  });

  it('a dashboard view keeps its widgets and narrows them by its toolbar by default', () => {
    const s = viewSettingsSchema.parse({
      dashboard: { widgets: [{ id: 'w1', type: 'chart', position: { x: 0, y: 0, w: 6, h: 4 } }] },
    });
    expect(s.dashboard).toEqual({
      apply_view_filter: true,
      widgets: [{ id: 'w1', type: 'chart', title: '', position: { x: 0, y: 0, w: 6, h: 4 }, settings: {} }],
    });
    expect(
      viewSettingsSchema.safeParse({
        dashboard: { widgets: [{ id: 'w', type: 'board_view', position: { x: 0, y: 0, w: 1, h: 1 } }] },
      }).success,
    ).toBe(false);
  });
});
