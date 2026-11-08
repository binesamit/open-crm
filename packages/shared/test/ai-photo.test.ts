// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  actionSentence,
  aiColumnSettingsSchema,
  aiTool,
  generateImageSources,
  matchTrigger,
  recipeSchema,
  t,
  triggerSentence,
  TRIGGER_EVENT_TYPES,
  triggerSchema,
  validateRecipe,
  webhookEventsOf,
  webhookWants,
  type AutomationEvent,
} from '../src';

/**
 * Photos as input — the pure parts: the AI column's source photos and re-run settings, the
 * `file_added` trigger (schema, matching, validation, sentence), `generate_image`'s `source_column`, the
 * `file_added` webhook event and the tool's source inputs.
 */
const columns = [
  { key: 'name', type: 'name', title: 'Item', settings: {} },
  { key: 'photos', type: 'file', title: 'Photos', settings: {} },
  { key: 'sketches', type: 'file', title: 'Sketches', settings: {} },
  { key: 'notes', type: 'text', title: 'Notes', settings: {} },
];
const board = { columns, groups: [] };
const ctx = { automationId: 'a1', columns: columns.map((c) => ({ id: c.key, type: c.type, settings: c.settings })) };
const ev = (e: Partial<AutomationEvent>): AutomationEvent => ({
  id: 'evt',
  type: 'file.added',
  board_id: 'brd',
  item_id: 'itm',
  actor: { type: 'user', id: 'usr' },
  ...e,
});

describe('AI column: source photos and re-run', () => {
  it('defaults: no source columns, all their photos, no photo = from the description, a re-run versions', () => {
    expect(aiColumnSettingsSchema.parse({})).toMatchObject({
      source_image_columns: [],
      source_image_count: 'all',
      when_no_source_image: 'text',
      image_on_rerun: 'version',
    });
    const s = aiColumnSettingsSchema.parse({
      source_image_columns: ['photos', 'sketches'],
      source_image_count: 4,
      when_no_source_image: 'skip',
      image_on_rerun: 'replace',
    });
    expect(s).toMatchObject({
      source_image_columns: ['photos', 'sketches'],
      source_image_count: 4,
      when_no_source_image: 'skip',
      // Round 4: the old `replace` is read as `version`.
      image_on_rerun: 'version',
    });
    // No cap of 4 any more: 'all', or the newest N (1–20) of each column.
    expect(aiColumnSettingsSchema.parse({ source_image_count: 12 }).source_image_count).toBe(12);
    expect(aiColumnSettingsSchema.safeParse({ source_image_count: 0 }).success).toBe(false);
    expect(aiColumnSettingsSchema.safeParse({ source_image_count: 'some' }).success).toBe(false);
    expect(aiColumnSettingsSchema.safeParse({ when_no_source_image: 'fail' }).success).toBe(false);
    expect(aiColumnSettingsSchema.safeParse({ image_on_rerun: 'delete' }).success).toBe(false);
  });

  it('a column saved with the old single source_image_column reads as a list of one (its count kept)', () => {
    const old = aiColumnSettingsSchema.parse({ source_image_column: 'photos', source_image_count: 1 });
    expect(old).toMatchObject({ source_image_columns: ['photos'], source_image_count: 1 });
    expect(old).not.toHaveProperty('source_image_column');
    // The new key wins when both are there; an old null is just dropped.
    expect(
      aiColumnSettingsSchema.parse({ source_image_column: 'photos', source_image_columns: ['sketches'] })
        .source_image_columns,
    ).toEqual(['sketches']);
    expect(aiColumnSettingsSchema.parse({ source_image_column: null }).source_image_columns).toEqual([]);
  });
});

describe('the file_added trigger', () => {
  it('hears file.added on its column, or on any file column when none is set; never a cell change', () => {
    expect(TRIGGER_EVENT_TYPES.has('file.added')).toBe(true);
    const one = triggerSchema.parse({ type: 'file_added', column: 'photos' });
    const any = triggerSchema.parse({ type: 'file_added' });
    expect(matchTrigger(one, ev({ column_key: 'photos' }), ctx)).toBe(true);
    expect(matchTrigger(one, ev({ column_key: 'sketches' }), ctx)).toBe(false);
    expect(matchTrigger(any, ev({ column_key: 'sketches' }), ctx)).toBe(true);
    expect(matchTrigger(any, ev({ type: 'cell.changed', column_key: 'photos' }), ctx)).toBe(false);
    // A subitem's file is the sub-board's event: not this board's trigger.
    expect(matchTrigger(any, ev({ column_key: 'photos', sub: true }), ctx)).toBe(false);
  });

  it('validates the column as a file column', () => {
    const v = (trigger: Record<string, unknown>) =>
      validateRecipe(recipeSchema.parse({ trigger, actions: [{ type: 'create_update', body: 'x' }] }), board).errors;
    expect(v({ type: 'file_added' })).toEqual([]);
    expect(v({ type: 'file_added', column: 'photos' })).toEqual([]);
    expect(v({ type: 'file_added', column: 'notes' })).toEqual([
      { path: 'trigger.column', code: 'column_type', detail: 'text' },
    ]);
    expect(v({ type: 'file_added', column: 'ghost' })).toEqual([
      { path: 'trigger.column', code: 'column_not_found', detail: 'ghost' },
    ]);
  });

  it('reads as a sentence with a column blank ("any file column" when unset)', () => {
    const named = triggerSentence({ type: 'file_added', column: 'photos' }, board);
    expect(named.filter((p) => p.slot).map((p) => [p.slot, p.text])).toEqual([['trigger.column', 'Photos']]);
    const any = triggerSentence({ type: 'file_added' }, board);
    expect(any.find((p) => p.slot)?.text).toBe(t('auto.word.any_file_column'));
  });
});

describe('generate_image from a photo', () => {
  const recipe = (action: Record<string, unknown>) =>
    recipeSchema.parse({ trigger: { type: 'file_added', column: 'photos' }, actions: [action] });

  it('source_columns: file columns of the item, each checked', () => {
    const ok = validateRecipe(
      recipe({ type: 'generate_image', column: 'sketches', source_columns: ['photos', 'sketches'], prompt: 'x' }),
      board,
    );
    expect(ok.errors).toEqual([]);
    const bad = validateRecipe(
      recipe({ type: 'generate_image', column: 'sketches', source_columns: ['photos', 'notes', 'ghost'], prompt: 'x' }),
      board,
    );
    expect(bad.errors).toEqual([
      { path: 'actions.0.source_columns', code: 'column_type', detail: 'text' },
      { path: 'actions.0.source_columns', code: 'column_not_found', detail: 'ghost' },
    ]);
  });

  it('the sources as one shape: the new list, else the old single column (its newest image, as then)', () => {
    expect(generateImageSources({})).toEqual({ columns: [], count: 'all', whenNone: 'text' });
    expect(generateImageSources({ source_column: 'photos' })).toEqual({
      columns: ['photos'],
      count: 1,
      whenNone: 'text',
    });
    expect(
      generateImageSources({
        source_columns: ['sketches', 'photos', 'sketches'],
        source_column: 'notes',
        source_count: 3,
        when_no_source_image: 'skip',
      }),
    ).toEqual({ columns: ['sketches', 'photos'], count: 3, whenNone: 'skip' });
    expect(
      recipeSchema.safeParse({
        trigger: { type: 'file_added' },
        actions: [{ type: 'generate_image', column: 'sketches', prompt: 'x', source_count: 'all' }],
      }).success,
    ).toBe(true);
    expect(
      recipeSchema.safeParse({
        trigger: { type: 'file_added' },
        actions: [{ type: 'generate_image', column: 'sketches', prompt: 'x', when_no_source_image: 'never' }],
      }).success,
    ).toBe(false);
  });

  it('source_column (the first version): a file column of the item', () => {
    const ok = validateRecipe(
      recipe({ type: 'generate_image', column: 'sketches', source_column: 'photos', prompt: 'A pencil sketch' }),
      board,
    );
    expect(ok.errors).toEqual([]);
    const wrong = validateRecipe(
      recipe({ type: 'generate_image', column: 'sketches', source_column: 'notes', prompt: 'x' }),
      board,
    );
    expect(wrong.errors).toEqual([{ path: 'actions.0.source_column', code: 'column_type', detail: 'text' }]);
    const gone = validateRecipe(
      recipe({ type: 'generate_image', column: 'sketches', source_column: 'ghost', prompt: 'x' }),
      board,
    );
    expect(gone.errors).toEqual([{ path: 'actions.0.source_column', code: 'column_not_found', detail: 'ghost' }]);
  });

  it('the sentence names the photo columns in order (the old single one too)', () => {
    const parts = actionSentence(
      recipe({ type: 'generate_image', column: 'sketches', source_column: 'photos', prompt: 'A sketch' }).actions[0]!,
      0,
      board,
    );
    expect(parts.find((p) => p.slot === 'actions.0.source_columns')?.text).toBe('Photos');
    const two = actionSentence(
      recipe({ type: 'generate_image', column: 'notes', source_columns: ['sketches', 'photos'], prompt: 'x' })
        .actions[0]!,
      0,
      board,
    );
    expect(two.find((p) => p.slot === 'actions.0.source_columns')?.text).toBe('Sketches, Photos');
  });
});

describe('the file_added webhook event', () => {
  it('a file event on the board (not a sub-board), narrowed by an optional column', () => {
    expect(webhookEventsOf({ type: 'file.added', sub: false, column_key: 'photos' })).toEqual(['file_added']);
    expect(webhookEventsOf({ type: 'file.added', sub: true, column_key: 'photos' })).toEqual([]);
    const src = { type: 'file.added', sub: false, column_key: 'photos', column_type: 'file' };
    expect(webhookWants({ event: 'file_added', config: {} }, src)).toBe(true);
    expect(webhookWants({ event: 'file_added', config: { column_id: 'photos' } }, src)).toBe(true);
    expect(webhookWants({ event: 'file_added', config: { column_id: 'sketches' } }, src)).toBe(false);
    expect(webhookWants({ event: 'column_changed', config: {} }, src)).toBe(false);
  });
});

describe('the generate_image tool', () => {
  it('takes a source file, a source column or several source columns', () => {
    const tool = aiTool('generate_image')!;
    expect(
      tool.input.safeParse({ item_id: '01J0000000000000000000ABCD', prompt: 'x', source_file_id: 'f1' }).success,
    ).toBe(true);
    expect(
      tool.input.safeParse({ item_id: '01J0000000000000000000ABCD', prompt: 'x', source_column_id: 'photos' }).success,
    ).toBe(true);
    expect(
      tool.input.safeParse({
        item_id: '01J0000000000000000000ABCD',
        prompt: 'x',
        source_column_ids: ['photos', 'sketches'],
      }).success,
    ).toBe(true);
    expect(
      tool.input.safeParse({ item_id: '01J0000000000000000000ABCD', prompt: 'x', source_column_ids: [] }).success,
    ).toBe(false);
    expect(tool.risk).toBe('sensitive');
  });
});
