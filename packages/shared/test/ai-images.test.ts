// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  actionSentence,
  aiColumnSettingsSchema,
  aiSettingsSchema,
  aiTool,
  buildAiImagePrompt,
  describeAction,
  PLAN_FEATURE_ACTIONS,
  recipeSchema,
  t,
  validateRecipe,
} from '../src';

/**
 * AI images — the pure parts: the account's image settings, the AI column's image output and its
 * description, the `generate_image` automation action (schema, validation, sentence slots, plan feature) and the
 * readable approval sentence of the tool.
 */
const columns = [
  { key: 'name', type: 'name', title: 'Item', settings: {} },
  { key: 'files', type: 'file', title: 'Files', settings: {} },
  { key: 'notes', type: 'text', title: 'Notes', settings: {} },
];

describe('AI images: settings and AI column', () => {
  it('account defaults: off until a connection is chosen; sizes and qualities validated', () => {
    expect(aiSettingsSchema.parse({}).images).toEqual({
      connection_id: null,
      model: null,
      size: '1024x1024',
      quality: 'auto',
      max_images: 1,
      // AI image runs side by side, 1–4.
      concurrency: 1,
    });
    expect(aiSettingsSchema.safeParse({ images: { concurrency: 5 } }).success).toBe(false);
    expect(aiSettingsSchema.safeParse({ images: { size: '1024 x 1024' } }).success).toBe(false);
    expect(aiSettingsSchema.safeParse({ images: { max_images: 9 } }).success).toBe(false);
  });

  it('an AI column with image output: the instructions with the item values filled in', () => {
    const s = aiColumnSettingsSchema.parse({
      output: 'image',
      instructions: 'Poster for {Item}, mood: {Notes} {nope}',
    });
    expect(s).toMatchObject({ output: 'image', image_column: null, image_size: null });
    const prompt = buildAiImagePrompt(s, {
      name: 'Jazz night',
      fields: [{ title: 'Notes', text: 'calm' }],
      updates: [],
      labels: [],
      columns: columns.map((c) => ({ id: c.key, title: c.title, type: c.type })),
    });
    expect(prompt).toBe('Poster for Jazz night, mood: calm {nope}');
    expect(
      buildAiImagePrompt({ instructions: '' }, { name: 'Only name', fields: [], updates: [], labels: [], columns: [] }),
    ).toBe('Only name');
    expect(
      buildAiImagePrompt(
        { instructions: 'Logo of {item.name}' },
        { name: 'Bakery', fields: [], updates: [], labels: [], columns: [] },
      ),
    ).toBe('Logo of Bakery');
  });
});

describe('AI images: the automation action', () => {
  const recipe = (action: Record<string, unknown>) =>
    recipeSchema.parse({ trigger: { type: 'item_created' }, actions: [action] });

  it('a file column only; the prompt template is checked like the others', () => {
    const ok = validateRecipe(recipe({ type: 'generate_image', column: 'files', prompt: '{item.notes}' }), {
      columns,
      groups: [],
    });
    expect(ok.errors).toEqual([]);
    const wrong = validateRecipe(recipe({ type: 'generate_image', column: 'notes', prompt: 'x {item.ghost}' }), {
      columns,
      groups: [],
    });
    expect(wrong.errors).toEqual([{ path: 'actions.0.column', code: 'column_type', detail: 'text' }]);
    expect(wrong.warnings).toEqual([{ path: 'actions.0.prompt', code: 'unknown_template', detail: 'item.ghost' }]);
    expect(
      recipeSchema.safeParse({
        trigger: { type: 'item_created' },
        actions: [{ type: 'generate_image', column: 'files', prompt: 'x', size: 'huge' }],
      }).success,
    ).toBe(false);
  });

  it('costs money: the integration bucket and the plan feature `ai`', () => {
    expect(ACTIONS.generate_image).toMatchObject({ bucket: 'integration', columnTypes: ['file'], needsItem: true });
    expect(PLAN_FEATURE_ACTIONS.generate_image).toBe('ai');
  });

  it('the builder sentence has the column, source photo () and prompt blanks', () => {
    const parts = actionSentence(recipe({ type: 'generate_image', column: 'files', prompt: 'A logo' }).actions[0]!, 0, {
      columns,
      groups: [],
    });
    expect(parts.filter((p) => p.slot).map((p) => [p.slot, p.text])).toEqual([
      ['actions.0.column', 'Files'],
      ['actions.0.source_columns', t('auto.word.text_only')],
      ['actions.0.prompt', 'A logo'],
    ]);
  });
});

describe('AI images: the approval sentence', () => {
  it('into a column, or onto a new update', () => {
    const tool = aiTool('generate_image')!;
    const names = { name: (r: { kind: string; id: string }) => (r.kind === 'item' ? 'Poster' : 'Files') };
    const col = describeAction(tool, { item_id: 'i1', column_id: 'files', prompt: 'A fox', size: '1024x1024' }, names);
    expect(col).toMatchObject({ tool: 'generate_image', variant: null, params: { item: 'Poster', column: 'Files' } });
    expect(col.details).toEqual(
      expect.arrayContaining([
        { field: 'prompt', label: null, value: { kind: 'text', text: 'A fox' } },
        { field: 'size', label: null, value: { kind: 'text', text: '1024x1024' } },
      ]),
    );
    expect(describeAction(tool, { item_id: 'i1', prompt: 'A fox' }, names).variant).toBe('to_update');
  });
});
