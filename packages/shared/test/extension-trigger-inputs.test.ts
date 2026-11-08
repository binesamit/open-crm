// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { extensionManifestSchema, extensionTriggerInputsMatch, recipeSchema, TRIGGERS } from '../src';

/**
 * an extension's trigger may declare `inputs` set per automation (e.g. which of its buttons); a fire
 * runs only the automations whose stored values its payload carries. Automations without values hear every fire.
 */
const manifest = (trigger: Record<string, unknown>) => ({
  manifest_version: 1,
  id: 'meta',
  name: 'Meta',
  version: '1.0.0',
  publisher: { name: 'Labs' },
  permissions: ['boards:read'],
  origins: ['https://ext.example.com'],
  features: [{ type: 'automation_trigger', key: 'conversation_button', name: 'כפתור', ...trigger }],
});

describe('a trigger’s inputs (manifest)', () => {
  it('parses text inputs (type defaults to text); none by default', () => {
    const m = extensionManifestSchema.parse(manifest({ inputs: [{ key: 'button', label: 'כפתור' }] }));
    expect(m.features[0]).toMatchObject({ inputs: [{ key: 'button', label: 'כפתור', type: 'text' }] });
    expect(extensionManifestSchema.parse(manifest({})).features[0]).toMatchObject({ inputs: [] });
  });
  it('refuses a bad key, another type, or more than 10', () => {
    expect(extensionManifestSchema.safeParse(manifest({ inputs: [{ key: 'Bad Key', label: 'x' }] })).success).toBe(
      false,
    );
    expect(
      extensionManifestSchema.safeParse(manifest({ inputs: [{ key: 'n', label: 'x', type: 'number' }] })).success,
    ).toBe(false);
    const many = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, label: 'x' }));
    expect(extensionManifestSchema.safeParse(manifest({ inputs: many })).success).toBe(false);
  });
});

describe('an automation’s trigger inputs (recipe)', () => {
  const recipe = (trigger: Record<string, unknown>) => ({
    trigger: { type: 'extension_trigger', block: 'meta.conversation_button', ...trigger },
    actions: [{ type: 'create_update', body: 'x' }],
  });
  it('stores text values under input keys; an old recipe without them still parses', () => {
    expect(recipeSchema.parse(recipe({ inputs: { button: 'b-1' } })).trigger).toMatchObject({
      inputs: { button: 'b-1' },
    });
    expect(recipeSchema.parse(recipe({})).trigger).not.toHaveProperty('inputs');
    expect(recipeSchema.safeParse(recipe({ inputs: { button: 1 } })).success).toBe(false);
  });
});

describe('a fire runs only the automations whose values it carries', () => {
  const ev = (payload: unknown) => ({
    id: 'e',
    type: 'extension_trigger.fired',
    board_id: 'B',
    item_id: null,
    meta: { block: 'meta.conversation_button', payload },
    actor: { type: 'system', id: null },
  });
  const match = (inputs: Record<string, string> | undefined, payload: unknown) =>
    TRIGGERS.extension_trigger.match(
      { type: 'extension_trigger', block: 'meta.conversation_button', with_item: false, ...(inputs ? { inputs } : {}) },
      ev(payload) as never,
      {} as never,
    );
  it('its own button only', () => {
    expect(match({ button: 'b-1' }, { button: 'b-1', text: 'hi' })).toBe(true);
    expect(match({ button: 'b-1' }, { button: 'b-2' })).toBe(false);
    expect(match({ button: 'b-1' }, {})).toBe(false);
    expect(match({ button: '7' }, { button: 7 })).toBe(true);
    expect(match({ button: 'b-1' }, { button: { id: 'b-1' } })).toBe(false);
  });
  it('without values (or with empty ones): every fire, as before', () => {
    expect(match(undefined, { button: 'b-2' })).toBe(true);
    expect(match({}, {})).toBe(true);
    expect(match({ button: '' }, { button: 'b-9' })).toBe(true);
    expect(extensionTriggerInputsMatch(undefined, null)).toBe(true);
  });
});
