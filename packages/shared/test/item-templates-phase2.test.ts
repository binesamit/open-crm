// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  actionSentence,
  formSettingsSchema,
  itemTemplateAnswerFromCell,
  itemTemplateVarFits,
  mapRecipeRefs,
  proposeItemTemplateSources,
  recipeSchema,
  recipeText,
  validateRecipe,
  type Action,
  type RecipeBoard,
} from '../src';

/**
 * Item templates, phase 2: the automation actions `create_item_from_template` /
 * `add_template_subitems` (schema, registry, sentence, save-time checks, automation templates), where a template's
 * questions take their answers (an item's cells, a form's answers) and the form setting.
 */
const cols = (list: [key: string, type: string][]) =>
  list.map(([key, type]) => ({ key, type, title: key.toUpperCase(), settings: {} }));
const board: RecipeBoard = {
  columns: cols([
    ['name', 'name'],
    ['due', 'date'],
    ['span', 'timeline'],
    ['owner', 'people'],
    ['pkg', 'text'],
    ['link', 'board_relation'],
  ]),
  groups: [{ id: 'g1', title: 'New' }],
  itemTemplates: [
    {
      id: 'TPL1',
      variables: [
        { key: 'name', type: 'text' },
        { key: 'start', type: 'date' },
        { key: 'owner', type: 'person' },
      ],
    },
  ],
};
const recipe = (action: Record<string, unknown>, trigger: Record<string, unknown> = { type: 'item_created' }) =>
  recipeSchema.parse({ trigger, actions: [action] });

describe('the actions in the registry and the schema', () => {
  it('registers both actions (creating needs no trigger item; subitems do)', () => {
    expect(ACTIONS.create_item_from_template).toMatchObject({
      category: 'cross_board',
      needsItem: false,
      writes: true,
    });
    expect(ACTIONS.add_template_subitems).toMatchObject({ category: 'items', needsItem: true, writes: true });
  });

  it('parses a full action and refuses a bad variable key or source', () => {
    const r = recipe({
      type: 'create_item_from_template',
      board: '@self',
      template: 'TPL1',
      group: 'g1',
      variables: { start: 'due', owner: 'owner', name: 'name' },
      connect_column: 'link',
    });
    expect(r.actions[0]).toMatchObject({ type: 'create_item_from_template', template: 'TPL1', group: 'g1' });
    const bad = (variables: unknown) =>
      recipeSchema.safeParse({
        trigger: { type: 'item_created' },
        actions: [{ type: 'add_template_subitems', template: 'TPL1', variables }],
      }).success;
    expect(bad({ Start: 'due' })).toBe(false);
    expect(bad({ start: 'Due Date' })).toBe(false);
    expect(bad({ start: 'due' })).toBe(true);
    expect(
      recipeSchema.safeParse({ trigger: { type: 'item_created' }, actions: [{ type: 'add_template_subitems' }] })
        .success,
    ).toBe(false);
  });
});

describe('save-time checks (validateRecipe)', () => {
  const issues = (action: Record<string, unknown>, trigger?: Record<string, unknown>, b: RecipeBoard = board) =>
    validateRecipe(recipe(action, trigger), b).errors;

  it('accepts fitting sources: a date column for a date question, people for a person, any column (or the name) for text', () => {
    expect(
      issues({
        type: 'create_item_from_template',
        board: '@self',
        template: 'TPL1',
        variables: { start: 'span', owner: 'owner', name: 'pkg' },
        connect_column: 'link',
      }),
    ).toEqual([]);
    expect(
      issues({ type: 'add_template_subitems', template: 'TPL1', variables: { name: 'name', start: 'due' } }),
    ).toEqual([]);
  });

  it('refuses an unknown template, an unknown question, a missing column and a column of the wrong type', () => {
    expect(issues({ type: 'add_template_subitems', template: 'NOPE' })).toEqual([
      { path: 'actions.0.template', code: 'item_template_not_found', detail: 'NOPE' },
    ]);
    expect(issues({ type: 'add_template_subitems', template: 'TPL1', variables: { other: 'pkg' } })).toEqual([
      { path: 'actions.0.variables.other', code: 'item_template_unknown_variable', detail: 'other' },
    ]);
    expect(issues({ type: 'add_template_subitems', template: 'TPL1', variables: { start: 'gone' } })).toEqual([
      { path: 'actions.0.variables.start', code: 'column_not_found', detail: 'gone' },
    ]);
    expect(issues({ type: 'add_template_subitems', template: 'TPL1', variables: { start: 'pkg' } })).toEqual([
      { path: 'actions.0.variables.start', code: 'column_type', detail: 'text' },
    ]);
    expect(issues({ type: 'add_template_subitems', template: 'TPL1', variables: { owner: 'name' } })).toEqual([
      { path: 'actions.0.variables.owner', code: 'column_type', detail: 'name' },
    ]);
    expect(
      issues({ type: 'create_item_from_template', board: '@self', template: 'TPL1', connect_column: 'pkg' }),
    ).toEqual([{ path: 'actions.0.connect_column', code: 'column_type', detail: 'text' }]);
  });

  it('a board-level trigger may create from a template, but has no item to answer from or add subitems to', () => {
    const daily = { type: 'every_time_period', period: 'day', time: '09:00', scope: 'board' };
    expect(issues({ type: 'create_item_from_template', board: '@self', template: 'TPL1' }, daily)).toEqual([]);
    expect(
      issues(
        { type: 'create_item_from_template', board: '@self', template: 'TPL1', variables: { start: 'due' } },
        daily,
      ),
    ).toEqual([{ path: 'actions.0.variables', code: 'needs_item' }]);
    expect(issues({ type: 'add_template_subitems', template: 'TPL1' }, daily)).toEqual([
      { path: 'actions.0.type', code: 'needs_item' },
    ]);
  });

  it('without the templates (not loaded) only the columns are checked', () => {
    const { itemTemplates: _skip, ...plain } = board;
    expect(
      issues({ type: 'add_template_subitems', template: 'ANY', variables: { x: 'due' } }, undefined, plain),
    ).toEqual([]);
  });
});

describe('the sentence', () => {
  const sb = {
    columns: board.columns,
    groups: board.groups,
    boardName: (id: string) => (id === 'B2' ? 'Projects' : undefined),
    itemTemplateName: (id: string) => (id === 'TPL1' ? 'Onboarding' : undefined),
  };
  const text = (a: Record<string, unknown>) =>
    actionSentence(a as Action, 0, sb, 'en')
      .map((p) => p.text)
      .join('');

  it('names the template and the board, with blanks for both', () => {
    const parts = actionSentence(
      { type: 'create_item_from_template', board: 'B2', template: 'TPL1' } as Action,
      0,
      sb,
      'en',
    );
    expect(parts.filter((p) => p.slot).map((p) => p.slot)).toEqual(['actions.0.template', 'actions.0.board']);
    expect(text({ type: 'create_item_from_template', board: 'B2', template: 'TPL1' })).toContain('Onboarding');
    expect(text({ type: 'create_item_from_template', board: 'B2', template: 'TPL1' })).toContain('Projects');
    expect(text({ type: 'add_template_subitems', template: 'TPL1' })).toContain('Onboarding');
  });

  it('reads in Hebrew too (the automation title)', () => {
    const r = recipe({ type: 'add_template_subitems', template: 'TPL1' });
    expect(recipeText(r, sb, 'he')).toContain('Onboarding');
  });
});

describe('automation templates (taken off the board)', () => {
  it('the variables’ sources and the link columns are board references, picked again where installed', () => {
    const seen: string[] = [];
    const out = mapRecipeRefs(
      {
        trigger: { type: 'item_created' },
        actions: [
          {
            type: 'create_item_from_template',
            board: '@self',
            template: 'TPL1',
            variables: { start: 'due', name: 'name' },
            connect_column: 'link',
          },
          { type: 'add_template_subitems', template: 'TPL1', variables: { owner: 'owner' } },
        ],
      },
      (ref) => {
        if (ref.kind !== 'column') return undefined;
        seen.push(ref.key);
        return `x_${ref.key}`;
      },
    ) as { actions: Record<string, unknown>[] };
    expect(out.actions[0]!.variables).toEqual({ start: 'x_due', name: 'name' });
    expect(out.actions[0]!.connect_column).toBe('x_link');
    expect(out.actions[1]!.variables).toEqual({ owner: 'x_owner' });
    expect(seen).toEqual(expect.arrayContaining(['due', 'link', 'owner']));
  });
});

describe('answers from cells', () => {
  it('fits by type', () => {
    expect(itemTemplateVarFits('date', 'date')).toBe(true);
    expect(itemTemplateVarFits('date', 'timeline')).toBe(true);
    expect(itemTemplateVarFits('date', 'text')).toBe(false);
    expect(itemTemplateVarFits('person', 'people')).toBe(true);
    expect(itemTemplateVarFits('person', 'name')).toBe(false);
    expect(itemTemplateVarFits('text', 'status')).toBe(true);
    expect(itemTemplateVarFits('text', 'name')).toBe(true);
  });

  it('a date from a date or a timeline, people (no teams) from a people column, text from any text', () => {
    expect(itemTemplateAnswerFromCell('date', { type: 'date', value: { date: '2026-11-08', time: '10:00' } })).toBe(
      '2026-11-08',
    );
    expect(
      itemTemplateAnswerFromCell('date', { type: 'timeline', value: { from: '2026-11-08', to: '2026-11-20' } }),
    ).toBe('2026-11-08');
    expect(itemTemplateAnswerFromCell('date', { type: 'text', value: '2026-11-08' })).toBeUndefined();
    expect(
      itemTemplateAnswerFromCell('person', {
        type: 'people',
        value: {
          persons_and_teams: [
            { id: 'U1', kind: 'person' },
            { id: 'T1', kind: 'team' },
          ],
        },
      }),
    ).toEqual(['U1']);
    expect(
      itemTemplateAnswerFromCell('person', {
        type: 'people',
        value: { persons_and_teams: [{ id: 'T1', kind: 'team' }] },
      }),
    ).toBeUndefined();
    expect(itemTemplateAnswerFromCell('text', { type: 'status', value: { index: 1 }, text: ' Done ' })).toBe('Done');
    expect(itemTemplateAnswerFromCell('text', { type: 'text', value: null, text: 'x' })).toBeUndefined();
  });

  it('proposes a first mapping: the name for `name`, the first date and people columns', () => {
    expect(
      proposeItemTemplateSources(
        [
          { key: 'name', type: 'text' },
          { key: 'client', type: 'text' },
          { key: 'start', type: 'date' },
          { key: 'owner', type: 'person' },
        ],
        board.columns,
      ),
    ).toEqual({ name: 'name', start: 'due', owner: 'owner' });
    expect(proposeItemTemplateSources([{ key: 'start', type: 'date' }], cols([['pkg', 'text']]))).toEqual({});
  });
});

describe('the form setting', () => {
  it('defaults to none and keeps a template with its questions', () => {
    expect(formSettingsSchema.parse({}).item_template).toBeNull();
    const s = formSettingsSchema.parse({
      item_template: { template_id: 'TPL1', variables: { start: 'q1date', owner: 'q2pple' } },
    });
    expect(s.item_template).toEqual({ template_id: 'TPL1', variables: { start: 'q1date', owner: 'q2pple' } });
    expect(
      formSettingsSchema.safeParse({ item_template: { template_id: 'TPL1', variables: { start: 'Q 1' } } }).success,
    ).toBe(false);
  });
});
