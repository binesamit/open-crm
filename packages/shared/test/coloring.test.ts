// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { compileColoring, remapViewSettings, viewSettingsSchema, type ColoringRule } from '../src';
import { env, fixtureRows } from './query-fixtures';

/** Conditional coloring: filter rules → row / cell colours, first match wins. */
const rule = (id: string, column_id: string, operator: string, values: unknown[], extra: Partial<ColoringRule> = {}) =>
  ({
    id,
    rule: { kind: 'rule', column_id, operator, values, negate: false },
    target: 'row',
    color: 'crimson',
    ...extra,
  }) as ColoringRule;

describe('conditional coloring', () => {
  const rows = fixtureRows();
  const byName = (name: string) => rows.find((r) => r.name === name)!;

  it('colours whole items and cells; the first matching rule wins', () => {
    const colorOf = compileColoring(
      [
        rule('stuck', 'status', 'any_of', ['תקוע']),
        rule('big', 'amount', 'greater_than', [200], { target: 'cell', color: 'forest' }),
        rule('big-name', 'amount', 'greater_than', [200], { target: 'cell', column_id: 'note', color: 'blue' }),
        rule('any', 'status', 'is_not_empty', [], { color: 'gray' }), // after "stuck": Charlie stays red
      ],
      env(),
    );
    expect(colorOf(byName('Charlie'))).toEqual({ row: 'crimson', cells: {} });
    expect(colorOf(byName('Bravo'))).toEqual({ row: 'gray', cells: { amount: 'forest', note: 'blue' } });
    expect(colorOf(byName('Echo'))).toEqual({ cells: {} });
  });

  it('drops rules on columns that are gone, and follows a view copied to another board', () => {
    expect(compileColoring([rule('x', 'nope', 'is_empty', [])], env())(byName('Echo'))).toEqual({ cells: {} });
    const s = viewSettingsSchema.parse({
      coloring: [rule('a', 'status', 'is_empty', []), rule('b', 'note', 'is_empty', [])],
    });
    const moved = remapViewSettings(s, (k) => (k === 'status' ? 'state' : null));
    expect(moved.coloring.map((c) => c.rule.column_id)).toEqual(['state']);
  });
});
