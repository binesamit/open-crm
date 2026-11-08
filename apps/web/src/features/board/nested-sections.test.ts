// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { GROUP_PATH_SEP, type QueryEnv } from '@bines/shared';
import type { BoardDetail, Item } from './board-api';
import { nestedSections, viewLevels, visibleSections } from './nested-sections';

/**
 * Prod ק3: a nested grouping as the table's sections — parents as headers (all their rows, no "+ item")
 * the deepest level holding the rows with a seed of every level's value; the board's groups as the first level.
 */
const env: QueryEnv = {
  today: '2026-10-13',
  timezone: 'UTC',
  weekend: 'fri_sat',
  firstDay: 0,
  meId: 'u1',
  columns: [
    {
      id: 'st',
      type: 'status',
      settings: {
        labels: [
          { id: 0, label: 'Working', color: 'apricot' },
          { id: 1, label: 'Done', color: 'forest' },
        ],
      },
    },
    { id: 'n', type: 'numbers', settings: {} },
  ],
};
const board = {
  id: 'b1',
  groups: [
    { id: 'g1', title: 'Q4', color: 'blue', position: 'a' },
    { id: 'g2', title: 'Q1', color: 'forest', position: 'b' },
  ],
  columns: env.columns.map((c) => ({ ...c, title: c.id, read_only: false, restricted_edit: false })),
} as unknown as BoardDetail;
const item = (id: string, group: string, st: number, n: number) =>
  ({
    id,
    group_id: group,
    parent_item_id: null,
    depth: 0,
    name: id,
    position: id,
    key: null,
    cells: { st: { value: { index: st }, text: '' }, n: { value: n, text: String(n) } },
    created_at: '2026-10-01T00:00:00Z',
    created_by: null,
    updated_at: '2026-10-01T00:00:00Z',
  }) as unknown as Item;
const rows = [item('a', 'g1', 0, 5), item('b', 'g1', 1, 5), item('c', 'g2', 1, 5)];
const build = (q: Parameters<typeof viewLevels>[0]) =>
  nestedSections({ rows, levels: viewLevels(q, env), board, env, names: new Map(), members: [] });

describe('nested sections ( ק3)', () => {
  it("the board's groups, then status: headers with every row, leaves with a seed of both levels", () => {
    const sections = build({ subgroups: [{ column_id: 'st', direction: 'asc', collapse: false }] });
    expect(sections.map((s) => [s.key.split(GROUP_PATH_SEP).join(' › '), s.level, !!s.header, s.items.length])).toEqual(
      [
        ['__group__:g1', 0, true, 2],
        ['__group__:g1 › st:0', 1, false, 1],
        ['__group__:g1 › st:1', 1, false, 1],
        ['__group__:g2', 0, true, 1],
        ['__group__:g2 › st:1', 1, false, 1],
      ],
    );
    expect(sections[0]!.title).toBe('Q4');
    expect(sections[0]!.group?.id).toBe('g1');
    expect(sections[2]!.seed).toEqual({ groupId: 'g1', cells: { st: { index: 1 } } });
    expect(sections[0]!.seed).toBeUndefined();
  });

  it('a level that cannot be written leaves no seed below it; a column that is gone drops its level', () => {
    expect(viewLevels({ subgroups: [{ column_id: 'gone', direction: 'asc', collapse: false }] }, env)).toHaveLength(1);
    const sections = build({
      group_by: { column_id: 'st', direction: 'asc', collapse: false },
      subgroups: [{ column_id: 'n', direction: 'asc', collapse: false, mode: 'exact' }],
    });
    expect(sections.filter((s) => !s.header).every((s) => s.seed?.cells.st && s.seed.cells.n === 5)).toBe(true);
  });

  it('phones hide the levels under a collapsed parent', () => {
    const sections = build({ subgroups: [{ column_id: 'st', direction: 'asc', collapse: false }] });
    expect(visibleSections(sections, new Set([sections[0]!.key])).map((s) => s.key)).toEqual([
      sections[0]!.key,
      sections[3]!.key,
      sections[4]!.key,
    ]);
  });
});
