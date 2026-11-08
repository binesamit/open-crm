// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  choiceFilters,
  choiceQuery,
  columnTypes,
  enforcesChoiceFilter,
  hasChoiceFilter,
  normalizeChoiceSettings,
  planQuery,
  querySchema,
  remapChoiceSettings,
  rowMatches,
  viewChoiceQuery,
  type FilterGroup,
  type QueryEnv,
  type QueryRow,
} from '../src';

/** r19relfilter: relation column choice filters (settings, normalisation) and the "does not match" operators. */
const rule = (column_id: string, operator: string, values: unknown[] = []) => ({
  kind: 'rule' as const,
  column_id,
  operator: operator as never,
  values,
  negate: false,
});
const group = (...rules: ReturnType<typeof rule>[]): FilterGroup => ({
  kind: 'group',
  operator: 'and',
  negate: false,
  rules,
});

describe('relation choice settings', () => {
  const settings = {
    board_ids: ['b1', 'b2'],
    choice_filter: {
      b1: { mode: 'view', view_id: 'v1' },
      b2: { mode: 'filter', filter: group(rule('status', 'any_of', ['Active'])) },
      gone: { mode: 'view', view_id: 'v9' },
    },
  };

  it('is part of the board_relation settings schema', () => {
    const def = columnTypes.get('board_relation')!;
    expect(
      def.settingsSchema.safeParse({ ...settings, only_matching_in_cell: true, choice_caption: 'x' }).success,
    ).toBe(true);
    expect(def.settingsSchema.safeParse({ board_ids: [], choice_filter: { b1: { mode: 'nope' } } }).success).toBe(
      false,
    );
    expect(def.filterOperators).toContain('has_unmatched_link');
  });

  it('keeps only linked boards and non-empty filters', () => {
    expect(Object.keys(choiceFilters(settings))).toEqual(['b1', 'b2']);
    expect(hasChoiceFilter({ board_ids: ['b1'], choice_filter: { b1: { mode: 'filter', filter: group() } } })).toBe(
      false,
    );
    const n = normalizeChoiceSettings(settings);
    expect(Object.keys(n.choice_filter as object)).toEqual(['b1', 'b2']);
    expect(
      'choice_filter' in normalizeChoiceSettings({ board_ids: [], choice_filter: { b1: settings.choice_filter.b1 } }),
    ).toBe(false);
  });

  it('enforces in the API by default', () => {
    expect(enforcesChoiceFilter({})).toBe(true);
    expect(enforcesChoiceFilter({ choice_filter_api: false })).toBe(false);
  });

  it("never reads other relations' marks (no loops between boards)", () => {
    const q = choiceQuery(group(rule('rel', 'has_unmatched_link'), rule('status', 'is_not_empty')));
    expect(q.filter!.rules).toHaveLength(1);
    const v = viewChoiceQuery(
      querySchema.parse({ filter: group(rule('rel', 'no_unmatched_link')), sort: [{ column_id: 'status' }] }),
    );
    expect(v.filter!.rules).toHaveLength(0);
    expect(v.sort).toEqual([]);
  });
});

describe('has a link that does not match', () => {
  const env = (unmatched?: string[]): QueryEnv => ({
    columns: [{ id: 'rel', type: 'board_relation', settings: { board_ids: ['b1'] } }],
    meId: null,
    today: '2026-10-07',
    timezone: 'UTC',
    weekend: 'fri_sat',
    firstDay: 0,
    ...(unmatched ? { relationUnmatched: { rel: unmatched } } : {}),
  });
  const row = (id: string, ids: string[]): QueryRow => ({
    id,
    group_id: 'g',
    parent_item_id: null,
    depth: 0,
    name: id,
    position: 'a',
    key: null,
    cells: ids.length ? { rel: { value: { item_ids: ids }, text: '' } } : {},
    created_at: '2026-01-01T00:00:00Z',
    created_by: null,
    updated_at: '2026-01-01T00:00:00Z',
  });
  const match = (op: string, e: QueryEnv, r: QueryRow) =>
    rowMatches(planQuery(querySchema.parse({ filter: group(rule('rel', op)) }), e), r, 'UTC');

  it('reads the unmatched linked items from the env', () => {
    const e = env(['x']);
    expect(match('has_unmatched_link', e, row('1', ['x', 'y']))).toBe(true);
    expect(match('has_unmatched_link', e, row('2', ['y']))).toBe(false);
    expect(match('no_unmatched_link', e, row('2', ['y']))).toBe(true);
    expect(match('no_unmatched_link', e, row('3', []))).toBe(true);
  });

  it('without marks nothing is unmatched', () => {
    expect(match('has_unmatched_link', env(), row('1', ['x']))).toBe(false);
    expect(match('no_unmatched_link', env(), row('1', ['x']))).toBe(true);
  });
});

describe('remapChoiceSettings (a board copied together with its linked board)', () => {
  const settings = {
    board_ids: ['self', 'other'],
    allow_multiple: true,
    choice_filter: {
      self: { mode: 'filter', filter: group(rule('status', 'any_of', [1]), rule('__group__', 'any_of', ['g1', 'g9'])) },
      other: { mode: 'view', view_id: 'v-other' },
    },
  };
  it('moves the copied board, its view, columns and groups to the copies; other boards stay', () => {
    const out = remapChoiceSettings(
      { ...settings, choice_filter: { ...settings.choice_filter, self: { mode: 'view', view_id: 'v1' } } },
      { board: (id) => (id === 'self' ? 'copy' : undefined), view: (id) => (id === 'v1' ? 'v1-copy' : undefined) },
    );
    expect(out.board_ids).toEqual(['copy', 'other']);
    expect(out.choice_filter).toEqual({
      copy: { mode: 'view', view_id: 'v1-copy' },
      other: { mode: 'view', view_id: 'v-other' },
    });
    const built = remapChoiceSettings(settings, {
      board: (id) => (id === 'self' ? 'copy' : undefined),
      column: (_b, key) => (key === 'status' ? 'status_2' : undefined),
      group: (id) => (id === 'g1' ? 'g1-copy' : undefined),
    });
    expect((built.choice_filter as Record<string, unknown>).copy).toEqual({
      mode: 'filter',
      filter: group(rule('status_2', 'any_of', [1]), rule('__group__', 'any_of', ['g1-copy', 'g9'])),
    });
    // The result is still a valid column setting: the filter is on a board the column links to.
    expect(Object.keys(choiceFilters(built)).sort()).toEqual(['copy', 'other']);
  });
  it('a view that was not copied keeps its id (the column says the view is gone)', () => {
    const out = remapChoiceSettings(
      { board_ids: ['self'], choice_filter: { self: { mode: 'view', view_id: 'private-one' } } },
      { board: () => 'copy', view: () => undefined },
    );
    expect(out.choice_filter).toEqual({ copy: { mode: 'view', view_id: 'private-one' } });
  });
});
