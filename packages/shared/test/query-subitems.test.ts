// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  applyPlan,
  compileColoring,
  descendantsOf,
  matchingSubitems,
  matchingSubtree,
  matchingSubtreeWithPaths,
  planQuery,
  planUsesSubitems,
  querySchema,
  type QueryEnv,
  type QueryRow,
} from '../src';

/** D14 + M4.5: filters that read subitems — `sub:<key>` rules, match_children for search and Person. */
const labels = [
  { id: 0, label: 'Working', color: 'yellow', index: 0 },
  { id: 1, label: 'Done', color: 'forest', index: 1, is_done: true },
];
const env: QueryEnv = {
  columns: [{ id: 'status', type: 'status', settings: { labels } }],
  subitems: [
    { id: 'state', type: 'status', settings: { labels } },
    { id: 'owner', type: 'people', settings: {} },
  ],
  meId: 'me',
  today: '2026-10-03',
  timezone: 'Asia/Jerusalem',
  weekend: 'fri_sat',
  firstDay: 0,
};
const row = (id: string, name: string, cells: QueryRow['cells'] = {}, subitems?: QueryRow[]): QueryRow => ({
  id,
  group_id: 'g',
  parent_item_id: null,
  depth: 0,
  name,
  position: id,
  key: null,
  cells,
  created_at: '2026-10-01T00:00:00Z',
  created_by: null,
  updated_at: '2026-10-01T00:00:00Z',
  ...(subitems ? { subitems } : {}),
});
const sub = (id: string, name: string, state: number, owner?: string) =>
  row(id, name, {
    state: { value: { index: state }, text: labels[state]!.label },
    ...(owner ? { owner: { value: { persons_and_teams: [{ id: owner, kind: 'person' }] }, text: owner } } : {}),
  });

const a1 = sub('a1', 'write spec', 0, 'me');
const a2 = sub('a2', 'review', 1);
const b1 = sub('b1', 'deploy', 1);
const rows = [
  row('a', 'Alpha', { status: { value: { index: 1 }, text: 'Done' } }, [a1, a2]),
  row('b', 'Beta', {}, [b1]),
  row('c', 'Gamma', {}, []),
];
const names = (q: unknown) => applyPlan(rows, planQuery(querySchema.parse(q), env), env.timezone).map((r) => r.name);

describe('filters on subitems (D14)', () => {
  it('a sub: rule keeps items with a matching subitem (and items without subitems)', () => {
    const q = {
      filter: {
        kind: 'group',
        operator: 'and',
        rules: [{ column_id: 'sub:state', operator: 'any_of', values: ['Working'] }],
      },
    };
    // Gamma has no subitems: a subitem rule does not exclude it (owner fix6-server 1).
    expect(names(q)).toEqual(['Alpha', 'Gamma']);
    expect(planUsesSubitems(planQuery(querySchema.parse(q), env))).toBe(true);
    // Combined with a rule on the item itself.
    expect(
      names({
        filter: {
          kind: 'group',
          operator: 'or',
          rules: [
            { column_id: 'sub:state', operator: 'any_of', values: ['Done'] },
            { column_id: 'status', operator: 'is_empty' },
          ],
        },
      }),
    ).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('the search always finds an item through its subitems; Person only with match_children', () => {
    expect(names({ search: 'deploy' })).toEqual(['Beta']);
    expect(names({ search: 'deploy', match_children: true })).toEqual(['Beta']);
    // By a subitem's stored value (its status label) too.
    expect(names({ search: 'working' })).toEqual(['Alpha']);
    // A board without subitems (no `env.subitems`) searches its items only — and stays in SQL.
    const flat = planQuery(querySchema.parse({ search: 'deploy' }), { ...env, subitems: undefined });
    expect(planUsesSubitems(flat)).toBe(false);
    expect(applyPlan(rows, flat, env.timezone)).toEqual([]);
    expect(names({ person: 'me' })).toEqual([]);
    expect(names({ person: 'me', match_children: true })).toEqual(['Alpha']);
  });

  it('shows only the subitems that keep the item — all of them when the item matches by itself', () => {
    const plan = planQuery(
      querySchema.parse({
        filter: {
          kind: 'group',
          operator: 'and',
          rules: [{ column_id: 'sub:state', operator: 'any_of', values: ['Done'] }],
        },
      }),
      env,
    );
    expect(matchingSubitems(plan, rows[0]!, env.timezone, [a1, a2]).map((c) => c.id)).toEqual(['a2']);
    const search = planQuery(querySchema.parse({ search: 'alpha', match_children: true }), env);
    expect(matchingSubitems(search, rows[0]!, env.timezone, [a1, a2]).map((c) => c.id)).toEqual(['a1', 'a2']);
  });

  it('reaches subitems of subitems: a match two levels down keeps the item and the path to it', () => {
    // Gamma → g1 (Working) → g11 (Done) → g111 (Working, "deep fix")
    const g1 = { ...sub('g1', 'plan', 0), parent_item_id: 'c', depth: 1 };
    const g11 = { ...sub('g11', 'build', 1), parent_item_id: 'g1', depth: 2 };
    const g111 = { ...sub('g111', 'deep fix', 0), parent_item_id: 'g11', depth: 3 };
    const byParent = new Map([
      ['c', [g1]],
      ['g1', [g11]],
      ['g11', [g111]],
    ]);
    expect(descendantsOf(byParent, 'c').map((x) => x.id)).toEqual(['g1', 'g11', 'g111']);
    const deepRows = [row('c', 'Gamma', {}, descendantsOf(byParent, 'c'))];
    const done = planQuery(
      querySchema.parse({
        filter: {
          kind: 'group',
          operator: 'and',
          rules: [{ column_id: 'sub:state', operator: 'any_of', values: ['Done'] }],
        },
      }),
      env,
    );
    expect(applyPlan(deepRows, done, env.timezone).map((r) => r.name)).toEqual(['Gamma']);
    const tree = matchingSubtree(done, deepRows[0]!, env.timezone, byParent);
    expect(Object.fromEntries([...tree].map(([k, v]) => [k, v.map((x) => x.id)]))).toEqual({
      c: ['g1'], // kept because its child matches
      g1: ['g11'],
      g11: [], // g111 is Working: hidden
    });
    const search = planQuery(querySchema.parse({ search: 'deep' }), env);
    expect(applyPlan(deepRows, search, env.timezone).map((r) => r.name)).toEqual(['Gamma']);
    expect(
      matchingSubtree(search, deepRows[0]!, env.timezone, byParent)
        .get('g11')!
        .map((x) => x.id),
    ).toEqual(['g111']);
  });

  it('option א: a subitem kept only as the path to a deeper match is flagged path-only', () => {
    // Fixes → s1 (Done) → s11 (Working); s2 (Working, no children); s3 (Done, no children)
    const s1 = { ...sub('s1', 'agents', 1), parent_item_id: 'f', depth: 1 };
    const s11 = { ...sub('s11', 'agents · plan', 0), parent_item_id: 's1', depth: 2 };
    const s2 = { ...sub('s2', 'tooltip', 0), parent_item_id: 'f', depth: 1 };
    const s3 = { ...sub('s3', 'done fix', 1), parent_item_id: 'f', depth: 1 };
    const byParent = new Map([
      ['f', [s1, s2, s3]],
      ['s1', [s11]],
    ]);
    const fixes = row('f', 'Fixes', {}, descendantsOf(byParent, 'f'));
    const filter = (rules: unknown[], negate = false) =>
      planQuery(querySchema.parse({ filter: { kind: 'group', operator: 'and', negate, rules } }), env);
    const shown = (plan: ReturnType<typeof planQuery>) => {
      const { tree, pathOnly } = matchingSubtreeWithPaths(plan, fixes, env.timezone, byParent);
      return {
        tree: Object.fromEntries([...tree].map(([k, v]) => [k, v.map((x) => x.id)])),
        pathOnly: [...pathOnly].sort(),
      };
    };
    // The reported view: a group "subitem status is not Done / Cancelled" AND the item's own rule. The Done s1 stays as
    // the path to its open child s11 (as before round 15), flagged so the table dims it; s3 (Done, nothing under
    // it) is hidden.
    const notDone = filter([
      { kind: 'group', operator: 'and', rules: [{ column_id: 'sub:state', operator: 'not_any_of', values: ['Done'] }] },
      { column_id: 'status', operator: 'not_any_of', values: ['Done'] },
    ]);
    const expected = { tree: { f: ['s1', 's2'], s1: ['s11'], s11: [], s2: [] }, pathOnly: ['s1'] };
    expect(applyPlan([fixes], notDone, env.timezone).map((r) => r.name)).toEqual(['Fixes']);
    expect(shown(notDone)).toEqual(expected);
    // The same with "is not done" and with a positive rule.
    expect(shown(filter([{ column_id: 'sub:state', operator: 'is_not_done' }]))).toEqual(expected);
    // A negated "is Done" reads "no subitem (on the path) is Done": the Done s1 cannot be a path.
    expect(shown(filter([{ column_id: 'sub:state', operator: 'any_of', values: ['Done'], negate: true }]))).toEqual({
      tree: { f: ['s2'], s2: [] },
      pathOnly: [],
    });
    expect(shown(filter([{ column_id: 'sub:state', operator: 'any_of', values: ['Working'] }]))).toEqual(expected);
    // "is Done": s1 and s3 match by themselves (no path flag); s11 is Working → hidden.
    expect(shown(filter([{ column_id: 'sub:state', operator: 'any_of', values: ['Done'] }]))).toEqual({
      tree: { f: ['s1', 's3'], s1: [], s3: [] },
      pathOnly: [],
    });
    // matchingSubtree is the same tree without the flags.
    expect(matchingSubtree(notDone, fixes, env.timezone, byParent)).toEqual(
      matchingSubtreeWithPaths(notDone, fixes, env.timezone, byParent).tree,
    );
    // The agreed rule stays: an item without subitems is not dropped by a subitem rule.
    const bare = row('x', 'No subitems', {}, []);
    expect(applyPlan([fixes, bare], notDone, env.timezone).map((r) => r.name)).toEqual(['Fixes', 'No subitems']);
  });

  it('the shown subtree agrees with the item result: a kept item always shows a path to what kept it', () => {
    const s1 = { ...sub('s1', 'agents', 1), parent_item_id: 'f', depth: 1 };
    const s11 = { ...sub('s11', 'agents · plan', 0), parent_item_id: 's1', depth: 2 };
    const byParent = new Map([
      ['f', [s1]],
      ['s1', [s11]],
    ]);
    const fixes = row('f', 'Fixes', {}, descendantsOf(byParent, 'f'));
    for (const operator of ['not_any_of', 'any_of'] as const)
      for (const values of [['Done'], ['Working']]) {
        const plan = planQuery(
          querySchema.parse({
            filter: { kind: 'group', operator: 'and', rules: [{ column_id: 'sub:state', operator, values }] },
          }),
          env,
        );
        const kept = applyPlan([fixes], plan, env.timezone).length > 0;
        const { tree } = matchingSubtreeWithPaths(plan, fixes, env.timezone, byParent);
        expect((tree.get('f') ?? []).length > 0).toBe(kept);
      }
  });

  describe('an item without subitems is not excluded by subitem rules (owner fix6-server 1)', () => {
    const rule = (operator: string, values: unknown[] = [], negate = false) => ({
      filter: { kind: 'group', operator: 'and', rules: [{ column_id: 'sub:state', operator, values, negate }] },
    });
    it.each([
      ['any_of', ['Working'], false, ['Alpha', 'Gamma']],
      ['any_of', ['Done'], false, ['Alpha', 'Beta', 'Gamma']],
      ['not_any_of', ['Done'], false, ['Alpha', 'Gamma']],
      ['is_not_done', [], false, ['Alpha', 'Gamma']],
      ['is_done', [], false, ['Alpha', 'Beta', 'Gamma']],
      ['is_empty', [], false, ['Gamma']],
      ['is_not_empty', [], false, ['Alpha', 'Beta', 'Gamma']],
      ['any_of', ['Working'], true, ['Beta', 'Gamma']],
    ] as const)('%s %j (negate %s)', (op, values, negate, expected) => {
      expect(names(rule(op, [...values], negate))).toEqual(expected);
    });

    it('is judged by its own rules: the subitem rule drops out of AND / OR groups', () => {
      const own = { column_id: 'status', operator: 'is_empty' };
      const subNotDone = { column_id: 'sub:state', operator: 'is_not_done' };
      // AND: Gamma passes the subitem rule and its status is empty; Beta's only subitem is Done.
      expect(names({ filter: { kind: 'group', operator: 'and', rules: [own, subNotDone] } })).toEqual(['Gamma']);
      // OR: for Gamma only its own rule counts.
      const ownDone = { column_id: 'status', operator: 'any_of', values: ['Done'] };
      expect(names({ filter: { kind: 'group', operator: 'or', rules: [ownDone, subNotDone] } })).toEqual(['Alpha']);
      // A negated group of subitem rules only.
      expect(
        names({ filter: { kind: 'group', operator: 'and', rules: [{ ...rule('is_done').filter, negate: true }] } }),
      ).toEqual(['Gamma']);
    });

    it('items whose subitems were not attached count as having none', () => {
      const bare = [row('x', 'Bare')];
      const plan = planQuery(querySchema.parse(rule('is_not_done')), env);
      expect(applyPlan(bare, plan, env.timezone).map((r) => r.name)).toEqual(['Bare']);
    });

    it('Person with match_children: an item without subitems is theirs only by its own people columns', () => {
      expect(names({ person: 'me', match_children: true })).toEqual(['Alpha']);
      const own = { ...env, columns: [...env.columns, { id: 'person', type: 'people', settings: {} }] };
      const mine = [
        row('m', 'Mine', { person: { value: { persons_and_teams: [{ id: 'me', kind: 'person' }] }, text: 'me' } }, []),
        row('n', 'Nobody', {}, []),
      ];
      const plan = planQuery(querySchema.parse({ person: 'me', match_children: true }), own);
      expect(applyPlan(mine, plan, env.timezone).map((r) => r.name)).toEqual(['Mine']);
    });

    it('conditional coloring paints only real subitem matches', () => {
      const paint = compileColoring(
        [
          {
            id: 'r',
            rule: { column_id: 'sub:state', operator: 'is_not_done' } as never,
            target: 'row',
            color: 'crimson',
          },
        ],
        env,
      );
      expect(rows.map((r) => paint(r).row ?? null)).toEqual(['crimson', null, null]);
    });
  });
});

describe('strict subitem filtering', () => {
  // Item → s1 (Done) → s11 (Working) → s111 (Working); s2 (Working). The reported case: "subitem not frozen" — a Done
  // (here: failing) subitem with a matching child under it.
  const s1 = { ...sub('s1', 'frozen', 1), parent_item_id: 'f', depth: 1 };
  const s11 = { ...sub('s11', 'under frozen', 0), parent_item_id: 's1', depth: 2 };
  const s111 = { ...sub('s111', 'deep under frozen', 0), parent_item_id: 's11', depth: 3 };
  const s2 = { ...sub('s2', 'open', 0), parent_item_id: 'f', depth: 1 };
  const byParent = new Map([
    ['f', [s1, s2]],
    ['s1', [s11]],
    ['s11', [s111]],
  ]);
  const item = row('f', 'Item', {}, descendantsOf(byParent, 'f'));
  const plan = (strict: boolean, rules: unknown[] = [{ column_id: 'sub:state', operator: 'is_not_done' }]) =>
    planQuery(querySchema.parse({ filter: { kind: 'group', operator: 'and', rules }, subitems_strict: strict }), env);
  const shown = (p: ReturnType<typeof planQuery>, r = item, m = byParent) => {
    const { tree, pathOnly } = matchingSubtreeWithPaths(p, r, env.timezone, m);
    return { tree: Object.fromEntries([...tree].map(([k, v]) => [k, v.map((x) => x.id)])), pathOnly: [...pathOnly] };
  };

  it('off (default): the failing subitem stays dimmed as the path to its matching children', () => {
    expect(querySchema.parse({}).subitems_strict).toBeUndefined();
    expect(shown(plan(false))).toEqual({
      tree: { f: ['s1', 's2'], s1: ['s11'], s11: ['s111'], s111: [], s2: [] },
      pathOnly: ['s1'],
    });
  });

  it('on: a failing subitem hides everything under it, at every depth; no path rows', () => {
    expect(shown(plan(true))).toEqual({ tree: { f: ['s2'], s2: [] }, pathOnly: [] });
    // Deeper: a failing sub-subitem cuts its own subtree, its matching parent stays.
    const t1 = { ...sub('t1', 'open', 0), parent_item_id: 'g', depth: 1 };
    const t11 = { ...sub('t11', 'done', 1), parent_item_id: 't1', depth: 2 };
    const t111 = { ...sub('t111', 'open under done', 0), parent_item_id: 't11', depth: 3 };
    const m = new Map([
      ['g', [t1]],
      ['t1', [t11]],
      ['t11', [t111]],
    ]);
    const g = row('g', 'Other', {}, descendantsOf(m, 'g'));
    expect(shown(plan(true), g, m)).toEqual({ tree: { g: ['t1'], t1: [] }, pathOnly: [] });
  });

  it('on: an item reached only through a failing subitem is not in the result; one with a matching chain is', () => {
    const only = { ...sub('o1', 'frozen', 1), parent_item_id: 'h', depth: 1 };
    const deep = { ...sub('o11', 'open under frozen', 0), parent_item_id: 'o1', depth: 2 };
    const hidden = row('h', 'Only through frozen', {}, [only, deep]);
    expect(applyPlan([item, hidden], plan(false), env.timezone).map((r) => r.name)).toEqual([
      'Item',
      'Only through frozen',
    ]);
    expect(applyPlan([item, hidden], plan(true), env.timezone).map((r) => r.name)).toEqual(['Item']);
    // An item matching by its own values stays, strict or not; an item without subitems is not excluded.
    const own = plan(true, [{ column_id: 'status', operator: 'any_of', values: ['Done'] }]);
    const doneItem = row('d', 'Done item', { status: { value: { index: 1 }, text: 'Done' } }, [only, deep]);
    expect(applyPlan([doneItem], own, env.timezone).map((r) => r.name)).toEqual(['Done item']);
    expect(applyPlan([row('x', 'Bare', {}, [])], plan(true), env.timezone).map((r) => r.name)).toEqual(['Bare']);
  });
});
