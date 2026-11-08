// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  actionSentence,
  AI_STYLE_COUNT_DEFAULT,
  AI_STYLE_COUNT_MAX,
  aiColumnSettingsSchema,
  aiMarkerSchema,
  aiStyleExamplesSchema,
  aiTool,
  recipeSchema,
  validateRecipe,
} from '../src';

/**
 * Style examples (round 3) — the pure parts: the AI column's `style_examples` (off by default; column
 * the board filter, newest N), the cell's `source_images.examples`, the `generate_image` action's `style_examples`
 * (schema, validation, sentence) and the MCP tool's `style_*` inputs.
 */
const columns = [
  { key: 'name', type: 'name', title: 'Item', settings: {} },
  { key: 'photos', type: 'file', title: 'Photos', settings: {} },
  { key: 'approved', type: 'file', title: 'Approved sketch', settings: {} },
  { key: 'stage', type: 'text', title: 'Stage', settings: {} },
];
const board = { columns, groups: [] };
const approved = {
  kind: 'group',
  operator: 'and',
  negate: false,
  rules: [{ kind: 'rule', column_id: 'stage', operator: 'any_of', values: ['Approved'], negate: false }],
};

describe('AI column: style examples', () => {
  it('off by default; on = a column, an optional filter, the newest 3 (1–10)', () => {
    expect(aiColumnSettingsSchema.parse({}).style_examples).toBeNull();
    expect(aiColumnSettingsSchema.parse({ style_examples: { column: 'approved' } }).style_examples).toEqual({
      column: 'approved',
      filter: null,
      count: AI_STYLE_COUNT_DEFAULT,
    });
    expect(AI_STYLE_COUNT_DEFAULT).toBe(3);
    const s = aiColumnSettingsSchema.parse({ style_examples: { column: 'approved', filter: approved, count: 10 } });
    expect(s.style_examples).toMatchObject({ column: 'approved', count: 10, filter: { operator: 'and' } });
    for (const count of [0, AI_STYLE_COUNT_MAX + 1, 2.5])
      expect(aiStyleExamplesSchema.safeParse({ column: 'approved', count }).success).toBe(false);
    expect(aiStyleExamplesSchema.safeParse({ column: '' }).success).toBe(false);
    // The filter is the board filter model (a bad operator is refused).
    expect(
      aiStyleExamplesSchema.safeParse({
        column: 'approved',
        filter: { kind: 'group', operator: 'and', rules: [{ column_id: 'stage', operator: 'nope' }] },
      }).success,
    ).toBe(false);
  });

  it('the cell records how many of the images sent were style examples', () => {
    const m = { at: 'x', model: 'm', cost_usd: 0, kind: 'custom' } as const;
    expect(aiMarkerSchema.parse({ ...m, source_images: { sent: 3, total: 4, examples: 2 } }).source_images).toEqual({
      sent: 3,
      total: 4,
      examples: 2,
    });
    expect(aiMarkerSchema.parse({ ...m, source_images: { sent: 1, total: 1 } }).source_images).toEqual({
      sent: 1,
      total: 1,
    });
  });
});

describe('generate_image with style_examples', () => {
  const recipe = (action: Record<string, unknown>) =>
    recipeSchema.parse({ trigger: { type: 'file_added', column: 'photos' }, actions: [action] });

  it('a file column of the board (checked), the filter and the count', () => {
    const r = recipe({
      type: 'generate_image',
      column: 'photos',
      prompt: 'x',
      style_examples: { column: 'approved', filter: approved, count: 2 },
    });
    expect(r.actions[0]).toMatchObject({ style_examples: { column: 'approved', count: 2 } });
    expect(validateRecipe(r, board).errors).toEqual([]);
    expect(
      validateRecipe(
        recipe({ type: 'generate_image', column: 'photos', prompt: 'x', style_examples: { column: 'stage' } }),
        board,
      ).errors,
    ).toEqual([{ path: 'actions.0.style_examples', code: 'column_type', detail: 'text' }]);
    expect(
      validateRecipe(
        recipe({ type: 'generate_image', column: 'photos', prompt: 'x', style_examples: { column: 'ghost' } }),
        board,
      ).errors,
    ).toEqual([{ path: 'actions.0.style_examples', code: 'column_not_found', detail: 'ghost' }]);
    expect(
      recipeSchema.safeParse({
        trigger: { type: 'file_added' },
        actions: [{ type: 'generate_image', column: 'photos', prompt: 'x', style_examples: { column: 'Bad Key' } }],
      }).success,
    ).toBe(false);
  });

  it('the sentence adds the style column', () => {
    const parts = actionSentence(
      recipe({
        type: 'generate_image',
        column: 'photos',
        source_columns: ['photos'],
        prompt: 'x',
        style_examples: { column: 'approved' },
      }).actions[0]!,
      0,
      board,
    );
    const text = parts.find((p) => p.slot === 'actions.0.source_columns')?.text ?? '';
    expect(text.startsWith('Photos ')).toBe(true);
    expect(text).toContain('Approved sketch');
  });
});

describe('the generate_image tool: style inputs', () => {
  it('style_column_id, an optional style_filter (as query_items), style_count 1–10 (default 3)', () => {
    const tool = aiTool('generate_image')!;
    const base = { item_id: '01J0000000000000000000ABCD', prompt: 'x' };
    const ok = tool.input.safeParse({
      ...base,
      style_column_id: 'approved',
      style_filter: { operator: 'and', rules: [{ column_id: 'stage', operator: 'any_of', values: ['Approved'] }] },
    });
    expect(ok.success).toBe(true);
    expect((ok.data as { style_count?: number }).style_count).toBe(3);
    expect(tool.input.safeParse({ ...base, style_column_id: 'approved', style_count: 11 }).success).toBe(false);
    expect(
      tool.input.safeParse({
        ...base,
        style_column_id: 'approved',
        style_filter: { rules: [{ column_id: 'stage', operator: 'nope' }] },
      }).success,
    ).toBe(false);
  });
});
