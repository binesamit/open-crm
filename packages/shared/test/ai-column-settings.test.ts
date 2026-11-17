// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  actionSentence,
  aiColumnRunRequestSchema,
  aiColumnSettingsSchema,
  aiOutputsOf,
  aiTool,
  aiValueSchema,
  columnTypes,
  recipeSchema,
  t,
  validateRecipe,
  type AiValue,
} from '../src';

/**
 * AI photos round 4 — the pure parts: the new settings and their defaults, how settings saved before
 * round 4 are read (they do not change by themselves), the cell's designs (`ai.outputs`), the run's `on_existing`,
 * and `generate_image`'s new fields (schema, validation, sentence, the MCP tool).
 */
const columns = [
  { key: 'name', type: 'name', title: 'Item', settings: {} },
  { key: 'photos', type: 'file', title: 'Photos', settings: {} },
  { key: 'designs', type: 'file', title: 'Designs', settings: {} },
  { key: 'notes', type: 'text', title: 'Notes', settings: {} },
];
const board = { columns, groups: [] };

describe('AI column settings, round 4', () => {
  it('a new column: each photo separately, one variation, a re-run makes a new version, free', () => {
    expect(aiColumnSettingsSchema.parse({})).toMatchObject({
      photo_mode: 'each',
      variations: 1,
      image_on_rerun: 'version',
      fidelity: 'free',
      fidelity_base_column: null,
    });
    expect(columnTypes.get('ai')!.defaultSettings).toMatchObject({ photo_mode: 'each', image_on_rerun: 'version' });
    const s = aiColumnSettingsSchema.parse({
      photo_mode: 'together',
      variations: 4,
      fidelity: 'locked',
      fidelity_base_column: 'base',
    });
    expect(s).toMatchObject({
      photo_mode: 'together',
      variations: 4,
      fidelity: 'locked',
      fidelity_base_column: 'base',
    });
    expect(aiColumnSettingsSchema.safeParse({ variations: 0 }).success).toBe(false);
    expect(aiColumnSettingsSchema.safeParse({ variations: 5 }).success).toBe(false);
    expect(aiColumnSettingsSchema.safeParse({ photo_mode: 'some' }).success).toBe(false);
    expect(aiColumnSettingsSchema.safeParse({ fidelity: 'exact' }).success).toBe(false);
  });

  it('settings saved before round 4 keep their behaviour: together, add stays add, replace becomes version', () => {
    // Every save stores the whole parsed settings, so a column of rounds 1–3 has `image_on_rerun` and no `photo_mode`.
    const savedAdd = aiColumnSettingsSchema.parse({
      output: 'image',
      image_on_rerun: 'add',
      source_image_columns: ['p'],
    });
    expect(savedAdd).toMatchObject({ photo_mode: 'together', image_on_rerun: 'add' });
    const savedReplace = aiColumnSettingsSchema.parse({ image_on_rerun: 'replace' });
    expect(savedReplace).toMatchObject({ photo_mode: 'together', image_on_rerun: 'version' });
    // Once saved by the form, the chosen value stays.
    expect(aiColumnSettingsSchema.parse({ ...savedAdd, photo_mode: 'each' }).photo_mode).toBe('each');
    expect(aiColumnSettingsSchema.parse(savedReplace)).toEqual(savedReplace);
  });

  it("the cell's designs: ai.outputs, or the one file of a cell made before round 4", () => {
    const marker = { at: '2026-10-13T00:00:00Z', model: 'gpt-image-1', cost_usd: 0.1, kind: 'custom' as const };
    const now: AiValue = aiValueSchema.parse({
      text: 'a.png, b.png',
      file_id: 'F1',
      ai: {
        ...marker,
        output: 'image',
        calls: 2,
        note: 'fidelity_no_base',
        outputs: [
          { file_id: 'F1', name: 'a.png', source_asset_id: 'P1', variation: 1, version: 2 },
          { file_id: 'F2', name: 'b.png', source_asset_id: 'P2', variation: 1, rejected: true },
        ],
      },
    });
    expect(aiOutputsOf(now).map((o) => [o.file_id, o.rejected ?? false])).toEqual([
      ['F1', false],
      ['F2', true],
    ]);
    const old = aiValueSchema.parse({ text: 'a.png', file_id: 'F0', ai: { ...marker, output: 'image' } });
    expect(aiOutputsOf(old)).toEqual([{ file_id: 'F0', name: 'a.png', source_asset_id: null, variation: 1 }]);
    // Text output, a typed cell, nothing: no designs.
    expect(aiOutputsOf(aiValueSchema.parse({ text: 'x', ai: marker }))).toEqual([]);
    expect(aiOutputsOf({ text: 'mine', file_id: 'F0' })).toEqual([]);
    expect(aiOutputsOf(null)).toEqual([]);
  });

  it('the run asks for version / add for items that already have designs (optional)', () => {
    expect(aiColumnRunRequestSchema.parse({ mode: 'all', on_existing: 'add' }).on_existing).toBe('add');
    expect(aiColumnRunRequestSchema.parse({ mode: 'all' }).on_existing).toBeUndefined();
    expect(aiColumnRunRequestSchema.safeParse({ mode: 'all', on_existing: 'replace' }).success).toBe(false);
  });
});

describe('generate_image, round 4', () => {
  const recipe = (action: Record<string, unknown>) =>
    recipeSchema.parse({
      trigger: { type: 'item_created' },
      actions: [{ type: 'generate_image', column: 'designs', prompt: 'A sketch', ...action }],
    });

  it('photo_mode / variations / fidelity / fidelity_base_column: parsed, validated, said in the sentence', () => {
    const r = recipe({
      source_columns: ['photos'],
      photo_mode: 'each',
      variations: 2,
      fidelity: 'locked',
      fidelity_base_column: 'designs',
    });
    expect(validateRecipe(r, board).errors).toEqual([]);
    const text = actionSentence(r.actions[0]!, 0, board).find((p) => p.slot === 'actions.0.source_columns')?.text;
    expect(text).toBe(
      `Photos (${t('auto.word.each_photo')}, ${t('auto.word.variations', { n: 2 })}, ${t('ai2.fidelity.locked')})`,
    );
    expect(() => recipe({ variations: 5 })).toThrow();
    expect(() => recipe({ photo_mode: 'all' })).toThrow();
    const bad = validateRecipe(recipe({ fidelity: 'locked', fidelity_base_column: 'notes' }), board).errors;
    expect(bad).toEqual([expect.objectContaining({ code: 'column_type' })]);
    const missing = validateRecipe(recipe({ fidelity: 'locked', fidelity_base_column: 'gone' }), board).errors;
    expect(missing).toEqual([expect.objectContaining({ code: 'column_not_found' })]);
  });

  it('the MCP tool: photo_mode (default together), fidelity (default free), the base column', () => {
    const tool = aiTool('generate_image')!;
    const parsed = tool.input.parse({ item_id: 'I1', prompt: 'x' }) as Record<string, unknown>;
    expect(parsed).toMatchObject({ photo_mode: 'together', fidelity: 'free' });
    expect(
      tool.input.parse({
        item_id: 'I1',
        prompt: 'x',
        photo_mode: 'each',
        fidelity: 'locked',
        fidelity_base_column_id: 'b',
      }),
    ).toMatchObject({ photo_mode: 'each', fidelity: 'locked', fidelity_base_column_id: 'b' });
    expect(tool.input.safeParse({ item_id: 'I1', prompt: 'x', fidelity: 'exact' }).success).toBe(false);
  });
});
