// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  applyTemplate,
  extractTemplate,
  matchTrigger,
  proposeSlots,
  recipeItemLevel,
  recipeParentLevel,
  recipeSchema,
  subTriggerDepth,
  validateRecipe,
  type TemplateBoard,
} from '../src';

/** Account automation templates (slots) and subitem scope (D14) — the pure halves. */
const labels = (...xs: string[]) => ({ labels: xs.map((label, id) => ({ id, label })) });
const source: TemplateBoard = {
  columns: [
    { key: 'status', type: 'status', title: 'Stage', settings: labels('New', 'Won') },
    { key: 'owner', type: 'people', title: 'Owner' },
    { key: 'notes', type: 'text', title: 'Notes' },
  ],
  subColumns: [
    { key: 'status', type: 'status', title: 'Task status', settings: labels('Open', 'Done') },
    { key: 'text', type: 'text', title: 'Detail' },
  ],
  groups: [{ id: 'g_won', title: 'Won' }],
};
const target: TemplateBoard = {
  columns: [
    { key: 'color_x', type: 'status', title: 'stage', settings: labels('Won', 'Lost') },
    { key: 'text_1', type: 'text', title: 'Other' },
    { key: 'text_2', type: 'text', title: 'Notes' },
    { key: 'people_1', type: 'people', title: 'Who' },
  ],
  subColumns: [
    { key: 'status_9', type: 'status', title: 'State', settings: labels('Done', 'Open') },
    { key: 'long', type: 'text', title: 'Detail' },
  ],
  groups: [
    { id: 'g1', title: 'Active' },
    { id: 'g2', title: 'won' },
  ],
};

const recipe = {
  trigger: { type: 'status_changed', column: 'status', labels: ['Won'] },
  conditions: {
    kind: 'group',
    operator: 'and',
    negate: false,
    rules: [{ kind: 'rule', column_id: 'status', operator: 'any_of', values: [1], negate: false }],
  },
  actions: [
    { type: 'move_to_group', group: 'g_won' },
    { type: 'set_column', column: 'notes', value: 'by {item.owner} at {today}' },
    { type: 'set_subitems_column', column: 'text', value: 'parent {item.name}' },
    { type: 'notify', to: 'column:owner', message: '{item.notes}' },
    { type: 'webhook', url: 'https://hooks.example.com/secret-path', secret: 'shh', headers: { a: 'b' } },
  ],
};

describe('save as template → slots', () => {
  const { recipe: saved, slots } = extractTemplate(recipe, source);
  it('every board reference becomes a slot; secrets stay behind', () => {
    expect(slots.map((s) => s.id).sort()).toEqual(
      [
        'column:main:notes',
        'column:main:owner',
        'column:main:status',
        'column:sub:text',
        'group:g_won',
        'label:main:status:Won',
        'text:actions.4.url',
      ].sort(),
    );
    expect(slots.find((s) => s.id === 'label:main:status:Won')).toMatchObject({ source_id: 1 });
    const hook = (saved.actions as Record<string, unknown>[])[4]!;
    expect(hook.url).toBe('');
    expect(hook.secret).toBeUndefined();
    expect(hook.headers).toBeUndefined();
  });

  it('proposes by type and title; labels follow their column; install rewrites every reference', () => {
    const proposals = proposeSlots(slots, target);
    const v = Object.fromEntries(proposals.map((p) => [p.id, p.value]));
    expect(v['column:main:status']).toBe('color_x');
    expect(v['column:main:notes']).toBe('text_2'); // same title wins over the first text column
    expect(v['column:main:owner']).toBe('people_1');
    expect(v['column:sub:text']).toBe('long');
    expect(v['group:g_won']).toBe('g2');
    expect(v['label:main:status:Won']).toBe('Won');
    expect(v['text:actions.4.url']).toBeNull(); // must be filled in

    const missing = applyTemplate(saved, slots, target).missing;
    expect(missing).toEqual(['text:actions.4.url']);
    const out = applyTemplate(saved, slots, target, { 'text:actions.4.url': 'https://example.com/new' });
    expect(out.missing).toEqual([]);
    const r = recipeSchema.parse(out.recipe);
    expect(r.trigger).toMatchObject({ column: 'color_x', labels: ['Won'] });
    // A filter value is a label id: the target's id of the same label.
    expect((r.conditions!.rules[0] as { column_id: string; values: unknown[] }).column_id).toBe('color_x');
    expect((r.conditions!.rules[0] as { values: unknown[] }).values).toEqual([0]);
    expect(r.actions[0]).toMatchObject({ type: 'move_to_group', group: 'g2' });
    expect(r.actions[1]).toMatchObject({ column: 'text_2', value: 'by {item.people_1} at {today}' });
    expect(r.actions[2]).toMatchObject({ column: 'long' });
    expect(r.actions[3]).toMatchObject({ to: 'column:people_1', message: '{item.text_2}' });
    expect(r.actions[4]).toMatchObject({ url: 'https://example.com/new' });
    expect(
      validateRecipe(r, {
        columns: target.columns.map((c) => ({ ...c, settings: c.settings ?? {} })),
        subColumns: target.subColumns!.map((c) => ({ ...c, settings: c.settings ?? {} })),
        groups: target.groups,
      }).errors,
    ).toEqual([]);
  });

  it('a pick overrides the proposal; a label nothing fits must be picked', () => {
    const noWon: TemplateBoard = {
      ...target,
      columns: [{ key: 's', type: 'status', title: 'S', settings: labels('A') }],
    };
    const p = proposeSlots(slots, noWon, { 'column:main:notes': 'nope' });
    expect(p.find((x) => x.id === 'label:main:status:Won')!.value).toBeNull();
    expect(p.find((x) => x.id === 'label:main:status:Won')!.options).toEqual([{ value: 'A', title: 'A' }]);
    expect(p.find((x) => x.id === 'column:main:notes')!.value).toBeNull(); // not a text column there
  });
});

describe('subitem scope (D14)', () => {
  const ev = {
    id: 'e',
    type: 'cell.changed',
    board_id: 'b',
    item_id: 'i',
    column_key: 'text',
    actor: { type: 'user', id: 'u' },
  };
  it('"when a subitem’s column changes" hears only the sub-board', () => {
    const t = { type: 'subitem_column_changed' as const, column: 'text' };
    expect(matchTrigger(t, { ...ev, sub: true }, { automationId: 'a', columns: [] })).toBe(true);
    expect(matchTrigger(t, ev, { automationId: 'a', columns: [] })).toBe(false);
    expect(
      matchTrigger(
        { ...t, column: 'name' },
        { ...ev, sub: true, type: 'item.renamed' },
        { automationId: 'a', columns: [] },
      ),
    ).toBe(true);
  });
  it('the run item’s and its parent’s levels', () => {
    expect(recipeItemLevel({ type: 'item_created' })).toBe('main');
    expect(recipeParentLevel({ type: 'item_created' })).toBeNull();
    expect(recipeItemLevel({ type: 'subitem_created' })).toBe('sub');
    expect(recipeParentLevel({ type: 'subitem_created' })).toBe('main');
    expect(recipeParentLevel({ type: 'subitem_created', level: 'sub_subitem' })).toBe('sub');
    const all = { type: 'subitem_status_changed' as const, column: 's', labels: 'any' as const, all_subitems: true };
    expect(recipeItemLevel(all)).toBe('main');
    expect(recipeItemLevel({ ...all, level: 'sub_subitem' })).toBe('sub');
    expect(subTriggerDepth({ type: 'subitem_created', level: 'subitem' })).toBe(1);
    expect(subTriggerDepth({ type: 'subitem_created' })).toBeNull();
  });
  it('validates a subitem recipe against the sub-board; without one it asks for subitems first', () => {
    const r = recipeSchema.parse({
      trigger: { type: 'subitem_status_changed', column: 'status', labels: ['Done'] },
      actions: [
        { type: 'set_column', column: 'text', value: 'x' },
        { type: 'copy_to_parent', source: 'text', column: 'notes' },
      ],
    });
    const board = {
      columns: source.columns.map((c) => ({ ...c, settings: c.settings ?? {} })),
      subColumns: source.subColumns!.map((c) => ({ ...c, settings: c.settings ?? {} })),
      groups: source.groups,
    };
    expect(validateRecipe(r, board).errors).toEqual([]);
    expect(validateRecipe(r, { ...board, subColumns: undefined }).errors[0]).toMatchObject({
      code: 'no_subitems_board',
    });
    const wrongLabel = recipeSchema.parse({ ...r, trigger: { ...r.trigger, labels: ['Won'] } });
    expect(validateRecipe(wrongLabel, board).errors[0]).toMatchObject({ code: 'label_not_found' });
  });
});
