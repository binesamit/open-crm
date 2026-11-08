// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  actionSentence,
  computedProblem,
  computedToKeys,
  computedToNames,
  evaluateComputed,
  matchTrigger,
  normalizeRecipe,
  parseComputed,
  parseComputedRef,
  roundComputed,
  triggerColumns,
  triggerSentence,
  validateRecipe,
  type AutomationEvent,
  type ComputedInput,
  type ComputedRef,
  type Recipe,
  type RecipeBoard,
  type SentenceBoard,
  type Trigger,
} from '../src';

/** set_computed (a value from the item, its parent and linked items) + triggers on several columns. */

const run = (expr: string, values: Record<string, ComputedInput | undefined>) =>
  evaluateComputed(parseComputed(expr), (r: ComputedRef) => values[r.raw]);

describe('computed expression', () => {
  it('reads the item, the parent and a linked item', () => {
    expect(parseComputedRef('qty')).toEqual({ raw: 'qty', scope: 'self', column: 'qty' });
    expect(parseComputedRef('parent.rate')).toEqual({ raw: 'parent.rate', scope: 'parent', column: 'rate' });
    expect(parseComputedRef(' service.price#sum|0 ')).toEqual({
      raw: ' service.price#sum|0 ',
      scope: 'relation',
      relation: 'service',
      column: 'price',
      attr: 'sum',
      fallback: 0,
    });
    expect(parseComputedRef('note|"none"')?.fallback).toBe('none');
  });

  it('computes quantity × minutes per unit (acceptance 1–3)', () => {
    const expr = '{qty|1} * {service.min_per_unit}';
    expect(run(expr, { 'qty|1': 3, 'service.min_per_unit': { many: [10] } })).toEqual({ ok: true, value: 30 });
    expect(run(expr, { 'qty|1': 5, 'service.min_per_unit': { many: [10] } })).toEqual({ ok: true, value: 50 });
    // An empty quantity takes its default.
    expect(run(expr, { 'qty|1': null, 'service.min_per_unit': { many: [10] } })).toEqual({ ok: true, value: 10 });
  });

  it('a missing value without a default is missing, not 0 (acceptance 4)', () => {
    expect(run('{qty} * {service.price}', { qty: 3, 'service.price': { many: [null] } })).toEqual({
      ok: false,
      reason: 'missing_value',
    });
    expect(run('{qty} * {service.price}', { qty: 3, 'service.price': { many: [] } })).toEqual({
      ok: false,
      reason: 'missing_value',
    });
    expect(run('{a} / {b}', { a: 1, b: 0 })).toEqual({ ok: false, reason: 'no_result' });
  });

  it('aggregates linked items and reads a timeline end', () => {
    const many = { many: [2, '3', null, 5] };
    expect(run('{s.p#sum}', { 's.p#sum': many })).toEqual({ ok: true, value: 10 });
    expect(run('{s.p#max}', { 's.p#max': many })).toEqual({ ok: true, value: 5 });
    expect(run('{s.p#count}', { 's.p#count': many })).toEqual({ ok: true, value: 3 });
    expect(run('{s.p}', { 's.p': many })).toEqual({ ok: true, value: 2 });
    expect(run('{tl#end}', { 'tl#end': { start: '2026-11-01', end: '2026-11-09' } })).toEqual({
      ok: true,
      value: '2026-11-09',
    });
  });

  it('uses the formula language: functions, IF, text and dates', () => {
    expect(run('ROUND({a} / 3, 2)', { a: 10 })).toEqual({ ok: true, value: 3.33 });
    expect(run('IF({a} > 5, "big", "small")', { a: 10 })).toEqual({ ok: true, value: 'big' });
    expect(run('MAX({a}, {b})', { a: 10, b: 12 })).toEqual({ ok: true, value: 12 });
    expect(run('ADD_DAYS({d}, 3)', { d: '2026-11-01' })).toEqual({ ok: true, value: '2026-11-04' });
    expect(roundComputed(10 / 3, 2)).toBe(3.33);
    expect(roundComputed('x', 2)).toBe('x');
  });

  it('reports syntax problems and unknown functions', () => {
    expect(computedProblem('{qty} *')).toEqual({ code: 'unexpected_end' });
    expect(computedProblem('NOPE({qty})')).toEqual({ code: 'unknown_function', token: 'NOPE' });
    expect(computedProblem('{qty} * {service.price|0}')).toBeNull();
  });

  it('shows names and stores keys', () => {
    const env = {
      item: [
        { id: 'qty', title: 'Quantity' },
        { id: 'service', title: 'Service' },
      ],
      parent: [{ id: 'rate', title: 'Rate' }],
      relations: [{ id: 'service', title: 'Service', columns: [{ id: 'min_per_unit', title: 'Minutes per unit' }] }],
    };
    const stored = '{qty|1} * {service.min_per_unit} + {parent.rate} & "{qty}"';
    const shown = computedToNames(stored, env);
    expect(shown).toBe('{Quantity|1} * {Service.Minutes per unit} + {parent.Rate} & "{qty}"');
    expect(computedToKeys(shown, env)).toBe(stored);
    // An unknown name stays as typed (the save names it).
    expect(computedToKeys('{Nothing} * 2', env)).toBe('{Nothing} * 2');
  });
});

describe('trigger on several columns', () => {
  const ev = (column_key: string, before: unknown, after: unknown): AutomationEvent => ({
    id: 'e',
    type: 'cell.changed',
    board_id: 'b',
    item_id: 'i',
    column_key,
    before: { value: before },
    after: { value: after },
    actor: { type: 'user', id: 'u' },
  });
  const ctx = { automationId: 'a', columns: [] };
  const t = { type: 'column_changed', column: 'service', columns: ['service', 'qty'] } as Trigger;

  it('fires on any of its columns and not on others', () => {
    expect(triggerColumns(t as never)).toEqual(['service', 'qty']);
    expect(matchTrigger(t, ev('qty', 1, 2), ctx)).toBe(true);
    expect(matchTrigger(t, ev('service', null, { item_ids: ['x'] }), ctx)).toBe(true);
    // The computed column's write (or a hand edit of it) does not (acceptance 5).
    expect(matchTrigger(t, ev('planned_minutes', 30, 45), ctx)).toBe(false);
    expect(matchTrigger(t, ev('qty', 2, 2), ctx)).toBe(false);
    const sub = { type: 'subitem_column_changed', column: 'qty', columns: ['qty', 'service'] } as Trigger;
    expect(matchTrigger(sub, { ...ev('service', null, 1), sub: true }, ctx)).toBe(true);
    expect(matchTrigger(sub, { ...ev('price', null, 1), sub: true }, ctx)).toBe(false);
  });

  it('takes `columns` alone through the API', () => {
    const r = normalizeRecipe(
      {
        trigger: { type: 'column_changed', columns: ['service', 'qty'] },
        actions: [{ type: 'set_computed', column: 'minutes', expression: '{qty} * 2' }],
      },
      { columns: [] },
    );
    expect(r.ok && r.recipe.trigger).toEqual({
      type: 'column_changed',
      column: 'service',
      columns: ['service', 'qty'],
    });
  });
});

describe('set_computed validation and sentence', () => {
  const c = (key: string, type: string, title = key) => ({ key, type, title, settings: {} });
  const board: RecipeBoard = {
    columns: [c('job_date', 'date')],
    groups: [],
    subColumns: [
      c('qty', 'numbers', 'Quantity'),
      c('service', 'board_relation', 'Service'),
      c('minutes', 'numbers', 'Planned minutes'),
      c('status', 'status'),
      c('f', 'formula'),
    ],
    relationColumns: { service: [c('min_per_unit', 'numbers', 'Minutes per unit')] },
  };
  const recipe = (expression: string, column = 'minutes', extra: Partial<Trigger> = {}): Recipe =>
    ({
      trigger: { type: 'subitem_column_changed', column: 'qty', columns: ['qty', 'service'], ...extra },
      actions: [{ type: 'set_computed', column, expression }],
    }) as Recipe;

  it('accepts the service line recipe', () => {
    expect(validateRecipe(recipe('{qty|1} * {service.min_per_unit} + {parent.job_date#end|0}'), board).errors).toEqual(
      [],
    );
  });

  it('names each problem with its path (acceptance 7)', () => {
    const errs = (r: Recipe) => validateRecipe(r, board).errors;
    expect(errs(recipe('{gone} * 2'))).toEqual([
      { path: 'actions.0.expression', code: 'column_not_found', detail: 'gone' },
    ]);
    expect(errs(recipe('{service.gone}'))).toEqual([
      { path: 'actions.0.expression', code: 'column_not_found', detail: 'service.gone' },
    ]);
    expect(errs(recipe('{qty.x}'))).toEqual([{ path: 'actions.0.expression', code: 'not_a_relation', detail: 'qty' }]);
    expect(errs(recipe('{parent.nope}'))).toEqual([
      { path: 'actions.0.expression', code: 'column_not_found', detail: 'parent.nope' },
    ]);
    expect(errs(recipe('{qty} *'))).toEqual([
      { path: 'actions.0.expression', code: 'expression_invalid', detail: 'unexpected_end' },
    ]);
    expect(errs(recipe('{qty}', 'status'))).toEqual([
      { path: 'actions.0.column', code: 'column_type', detail: 'status' },
    ]);
    expect(errs(recipe('{qty}', 'minutes', { columns: ['qty', 'nope'] } as never))).toEqual([
      { path: 'trigger.columns.1', code: 'column_not_found', detail: 'nope' },
    ]);
    expect(errs(recipe('{qty}', 'minutes', { columns: ['qty', 'f'] } as never))).toEqual([
      { path: 'trigger.columns.1', code: 'column_type', detail: 'formula' },
    ]);
    // An item on the board itself has no parent.
    expect(
      validateRecipe(
        {
          trigger: { type: 'column_changed', column: 'job_date' },
          actions: [{ type: 'set_computed', column: 'job_date', expression: '{parent.qty}' }],
        } as Recipe,
        board,
      ).errors,
    ).toEqual([{ path: 'actions.0.expression', code: 'no_parent', detail: 'parent.qty' }]);
  });

  it('reads as a sentence with names', () => {
    const sb: SentenceBoard = {
      columns: board.columns,
      groups: [],
      subColumns: board.subColumns,
      linkedColumns: (r) => (r === 'service' ? board.relationColumns!.service : undefined),
    };
    const r = recipe('{qty|1} * {service.min_per_unit}');
    const scoped = { ...sb };
    const t = triggerSentence(r.trigger, scoped, 'en')
      .map((p) => p.text)
      .join('');
    expect(t).toContain('Quantity');
    expect(t).toContain('Service');
    const a = actionSentence({ ...r.actions[0]!, round: 2, on_empty: 'zero' } as never, 0, {
      ...sb,
      columns: board.subColumns!,
    })
      .map((p) => p.text)
      .join('');
    expect(a).toContain('{Quantity|1} * {Service.Minutes per unit}');
    expect(a).toContain('Planned minutes');
  });
});
