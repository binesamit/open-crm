// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  applyPlan,
  columnTypes,
  planQuery,
  pruneQuery,
  querySchema,
  resolveField,
  ruleProblem,
  supportsOperator,
  SYSTEM_FIELDS,
  type FilterOperator,
  type FilterRule,
  type QueryEnv,
  type QueryInput,
  type QueryRow,
} from '../src';

/**
 * Prod bug: an imported board crashed on "Operator is_empty does not apply to <column>" (a
 * creation log). One list — the type's `filterOperators` (`supportsOperator`) — is what the builder offers and what
 * the engine accepts; a saved rule outside it is skipped, never a crash.
 */
const defs = columnTypes.all();
const env: QueryEnv = {
  columns: defs.map((d) => ({ id: `c_${d.type}`, type: d.type, settings: {} })),
  meId: 'u1',
  today: '2026-10-07',
  timezone: 'Asia/Jerusalem',
  weekend: 'fri_sat',
  firstDay: 0,
};
const row: QueryRow = {
  id: 'i1',
  group_id: 'g1',
  parent_item_id: null,
  depth: 0,
  name: 'One',
  position: 'a',
  key: null,
  cells: {},
  created_at: '2026-10-01T09:00:00Z',
  created_by: 'u1',
  updated_at: '2026-10-01T09:00:00Z',
};

/** A value of the right kind for each operator, so the rule is complete (not dropped as incomplete). */
const sample = (model: string, op: FilterOperator): unknown[] => {
  if (op === 'within_the_last' || op === 'within_the_next') return [3, 'days'];
  if (op === 'between') return model === 'date' ? ['2026-10-01', '2026-10-31'] : [1, 5];
  if (model === 'date') return ['TODAY'];
  if (model === 'number' || op.startsWith('greater') || op.startsWith('lower')) return [2];
  if (model === 'people') return ['me'];
  return ['x'];
};
const query = (rule: FilterRule): QueryInput => ({ filter: { kind: 'group', operator: 'and', rules: [rule] } });
const rule = (column_id: string, operator: FilterOperator, values: unknown[] = []): FilterRule => ({
  kind: 'rule',
  column_id,
  operator,
  values,
  negate: false,
});

describe('filter operators — one source for the builder and the engine', () => {
  for (const def of defs) {
    it(`${def.type}: every operator it has plans and evaluates`, () => {
      const id = `c_${def.type}`;
      const field = resolveField(id, env);
      for (const op of def.filterOperators) {
        expect(supportsOperator(field, op)).toBe(true);
        const r = rule(id, op, sample(def.filterModel, op));
        expect(ruleProblem(r, env)).toBeNull();
        const plan = planQuery(querySchema.parse(query(r)), env);
        expect(() => applyPlan([row], plan, env.timezone)).not.toThrow();
      }
    });
  }

  it('system fields: every operator plans', () => {
    for (const [id, f] of Object.entries(SYSTEM_FIELDS))
      for (const op of f.operators)
        expect(() => planQuery(querySchema.parse(query(rule(id, op, sample(f.model, op)))), env)).not.toThrow();
  });

  it('creation log: never empty, so no is_empty / is_not_empty — but every other date operator', () => {
    const ops = columnTypes.get('creation_log')!.filterOperators;
    expect(ops).not.toContain('is_empty');
    expect(ops).not.toContain('is_not_empty');
    for (const op of ['any_of', 'not_any_of', 'greater_than', 'lower_than', 'between', 'within_the_last'] as const)
      expect(ops).toContain(op);
  });
});

describe('saved rules that cannot run (old / imported data)', () => {
  const bad = rule('c_creation_log', 'is_empty');
  const good = rule('c_status', 'is_not_empty');

  it('ruleProblem names why: operator the type lacks, or a column that is gone', () => {
    expect(ruleProblem(bad, env)).toBe('invalid_operator');
    expect(ruleProblem(rule('gone', 'any_of', ['x']), env)).toBe('unknown_column');
    expect(ruleProblem(good, env)).toBeNull();
  });

  it('planQuery stays strict (a filter being saved is validated) …', () => {
    expect(() => planQuery(querySchema.parse(query(bad)), env)).toThrow(
      expect.objectContaining({ code: 'invalid_operator' }),
    );
  });

  it('… and pruneQuery drops only the invalid rule, at any depth, so the view keeps working', () => {
    const q = querySchema.parse({
      filter: {
        kind: 'group',
        operator: 'and',
        rules: [bad, good, { kind: 'group', operator: 'or', rules: [bad] }],
      },
    });
    const pruned = pruneQuery(q, env);
    expect(pruned.filter?.rules).toEqual([expect.objectContaining({ column_id: 'c_status' })]);
    expect(() => planQuery(pruned, env)).not.toThrow();
  });
});

describe('timer running / stopped', () => {
  const timer = (running: boolean | null): QueryRow => ({
    ...row,
    id: `t_${running}`,
    cells:
      running === null
        ? {}
        : { c_time_tracking: { value: { duration: 60, running, entries_count: 1 }, text: '00:01:00' } },
  });
  const rows = [timer(true), timer(false), timer(null)];
  const ids = (operator: FilterOperator) =>
    applyPlan(
      rows,
      planQuery(
        querySchema.parse({
          filter: { kind: 'group', operator: 'and', rules: [{ kind: 'rule', column_id: 'c_time_tracking', operator }] },
        } satisfies QueryInput),
        env,
      ),
      env.timezone,
    ).map((r) => r.id);

  it('is offered only on the timer column', () => {
    expect(supportsOperator(resolveField('c_time_tracking', env), 'is_running')).toBe(true);
    expect(supportsOperator(resolveField('c_numbers', env), 'is_running')).toBe(false);
  });
  it('matches the running timer, and the stopped or never started ones', () => {
    expect(ids('is_running')).toEqual(['t_true']);
    expect(ids('is_not_running')).toEqual(['t_false', 't_null']);
  });
});
