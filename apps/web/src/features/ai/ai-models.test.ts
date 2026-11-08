// SPDX-License-Identifier: AGPL-3.0-only
import type { AiModelList, AiModelOption } from '@bines/shared';
import { describe, expect, it } from 'vitest';
import {
  capabilityBadges,
  contextSize,
  defaultChoiceLabel,
  modelChoices,
  modelLabel,
  modelMaker,
  modelMenuEntries,
  modelPickerOptions,
} from './ai-api';

/**
 * Every model picker (agents, the assistant, AI columns, AI images, the flows AI, the connection's default) offers
 * the connection's live list only — for any provider — never Anthropic's catalogue.
 */
const option = (id: string, patch: Partial<AiModelOption> = {}): AiModelOption => ({
  id,
  display_name: id,
  created_at: null,
  price: null,
  price_source: null,
  default: false,
  capabilities: { tools: true, vision: false, json: true, streaming: true, max_context: null, image_generation: false },
  manual: false,
  ...patch,
});
const list = (data: AiModelOption[], default_model: string | null): AiModelList => ({
  data,
  source: 'live',
  fetched_at: '2026-10-08T00:00:00.000Z',
  default_model,
  default_auto: true,
});

describe('model pickers', () => {
  it('offer the live list as given, and nothing (no Claude catalogue) before it loads', () => {
    const gemini = list([option('gemini-2.5-pro'), option('gemini-2.5-flash')], 'gemini-2.5-pro');
    expect(modelChoices(gemini).map((m) => m.id)).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
    expect(modelChoices(undefined)).toEqual([]);
    // A saved model the list no longer has stays shown, by its id.
    expect(modelChoices(gemini, 'gemini-1.0-pro').map((m) => m.id)).toEqual([
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-1.0-pro',
    ]);
    expect(modelChoices(undefined, 'gpt-5').map((m) => m.id)).toEqual(['gpt-5']);
  });

  it('a model without a price is listed, its price "unknown"; capability badges follow', () => {
    const label = modelLabel(
      option('gpt-5', {
        display_name: 'GPT-5',
        capabilities: {
          tools: false,
          vision: true,
          json: true,
          streaming: true,
          max_context: 400_000,
          image_generation: false,
        },
      }),
    );
    expect(label.startsWith('\u2068GPT-5\u2069 · ')).toBe(true);
    expect(label.split(' · ')).toHaveLength(5);
    expect(label).toContain('400K');
    expect(modelLabel(option('m', { price: { input: 1.25, output: 10 } }))).toContain('$1.25/$10');
    expect(capabilityBadges(option('x').capabilities)).toEqual([]);
    expect(contextSize(1_048_576)).toBe('1.05M');
  });

  it('the "connection default" choice names the model the list says', () => {
    const l = list([option('mistral-large', { display_name: 'Mistral Large' })], 'mistral-large');
    expect(defaultChoiceLabel('Default', l)).toBe('Default · Mistral Large');
    expect(defaultChoiceLabel('Default', undefined)).toBe('Default');
  });
});

describe('long multi-maker lists (OpenRouter)', () => {
  const makers = ['OpenAI', 'Anthropic', 'Google', 'Mistral'];
  // 16 models, ranked: interleaved makers, the way a ranked OpenRouter list arrives.
  const ranked = Array.from({ length: 16 }, (_, i) => {
    const maker = makers[i % 4]!;
    return option(`${maker.toLowerCase()}/model-${i}`, { display_name: `${maker}: Model ${i}` });
  });

  it('names each model by its maker: the "Maker:" prefix, else the id prefix, else none', () => {
    expect(modelMaker(option('x/y', { display_name: 'Anthropic: Claude Haiku' }))).toBe('Anthropic');
    expect(modelMaker(option('mistralai/mistral-large', { display_name: 'Mistral Large' }))).toBe('Mistralai');
    expect(modelMaker(option('gpt-5'))).toBeNull();
  });

  it('groups by maker (makers in the order of their best-ranked model) and drops the prefix from the label', () => {
    const opts = modelPickerOptions(ranked, 'opt');
    expect([...new Set(opts.map((o) => o.group))]).toEqual(makers);
    expect(opts.slice(0, 4).map((o) => o.value)).toEqual([
      'openai/model-0',
      'openai/model-4',
      'openai/model-8',
      'openai/model-12',
    ]);
    expect(opts[0]!.label.startsWith('\u2068Model 0\u2069')).toBe(true);
    // The search still finds a model by its id and its maker.
    expect(opts[0]!.keywords).toBe('openai/model-0 OpenAI');
  });

  it('keeps a short or single-maker list flat and in its own order', () => {
    const short = ranked.slice(0, 5);
    expect(modelPickerOptions(short, 'opt').some((o) => 'group' in o)).toBe(false);
    expect(modelPickerOptions(short, 'opt').map((o) => o.value)).toEqual(short.map((m) => m.id));
  });

  it('as menu rows: a heading per maker, the current model checked', () => {
    const rows = modelMenuEntries(ranked, 'google/model-2', () => {}, 'opt');
    expect(rows.filter((r) => r.kind === 'label').map((r) => r.label)).toEqual(makers);
    expect(rows.find((r) => r.kind !== 'label' && r.kind !== 'separator' && 'checked' in r && r.checked)).toMatchObject(
      {
        keywords: 'google/model-2 Google',
      },
    );
  });
});
