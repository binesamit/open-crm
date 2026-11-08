// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { aiCost } from '@bines/shared';
import { type AnthropicLike, buildParams, createAiClient, scriptedAnthropic } from '../src';

/** A scripted Anthropic client: no network, no money (the planning notes "AGENTS-MCP" §7 DoD). */
const fake = (reply: Partial<Anthropic.Message>, opts: { listFails?: unknown } = {}) => {
  const calls: unknown[] = [];
  const client: AnthropicLike = {
    messages: {
      create: async (params) => {
        calls.push(params);
        return {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: params.model,
          content: [{ type: 'text', text: 'שלום', citations: null }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 0,
          },
          ...reply,
        } as Anthropic.Message;
      },
    },
    models: {
      list: async () => {
        if (opts.listFails) throw opts.listFails;
        return { data: [] };
      },
    },
  };
  return { client, calls };
};

const OPUS = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const SONNET = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

describe('AI cost', () => {
  it('prices a call from its real usage and the price given; no price = 0', () => {
    expect(aiCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, OPUS)).toBeCloseTo(24, 6);
    // Opus 5.5: $4 in / $20 out / $0.20 cache read / $5 cache write per 1M.
    expect(
      aiCost(
        { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 },
        OPUS,
      ),
    ).toBeCloseTo(0.004 + 0.004 + 0.001 + 0.005, 6);
    expect(aiCost({ input_tokens: 10, output_tokens: 10 }, null)).toBe(0);
  });
});

describe('createAiClient', () => {
  it('completes with usage and cost, never sending the key anywhere but the client', async () => {
    const { client, calls } = fake({});
    const ai = createAiClient({ provider: 'anthropic', apiKey: 'sk-test' }, { anthropic: client });
    const out = await ai.complete({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      price: SONNET,
    });
    expect(out.text).toBe('שלום');
    expect(out.costUsd).toBeCloseTo(0.002 + 0.002 + 0.001, 6);
    expect(JSON.stringify(calls)).not.toContain('sk-test');
  });

  it('a refusal yields no text', async () => {
    const { client } = fake({ stop_reason: 'refusal' as Anthropic.StopReason });
    const ai = createAiClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: client });
    const out = await ai.complete({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] });
    expect(out.stopReason).toBe('refusal');
    expect(out.text).toBe('');
  });

  it('test() reports a bad key without throwing', async () => {
    const ok = createAiClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fake({}).client });
    expect(await ok.test()).toEqual({ ok: true, error: null });
    const bad = createAiClient(
      { provider: 'anthropic', apiKey: 'k' },
      { anthropic: fake({}, { listFails: new Error('boom') }).client },
    );
    expect(await bad.test()).toEqual({ ok: false, error: 'unreachable' });
  });
});

describe('live model list (Fix: )', () => {
  it('reads every page of GET /v1/models, newest first, with what each model takes', async () => {
    const pages: Record<string, unknown> = {
      first: {
        data: [
          { id: 'claude-a', display_name: 'Claude A', created_at: '2026-01-01T00:00:00Z', capabilities: null },
          {
            id: 'claude-c',
            display_name: 'Claude C',
            created_at: '2026-09-01T00:00:00Z',
            capabilities: { thinking: { types: { adaptive: { supported: true } } }, effort: { supported: false } },
          },
        ],
        has_more: true,
        last_id: 'claude-c',
      },
      'claude-c': {
        data: [{ id: 'claude-b', display_name: '', created_at: '2026-05-01T00:00:00Z', capabilities: null }],
        has_more: false,
        last_id: 'claude-b',
      },
    };
    const seen: unknown[] = [];
    const client: AnthropicLike = {
      ...fake({}).client,
      models: {
        list: async (params) => {
          seen.push(params);
          return pages[(params as { after_id?: string })?.after_id ?? 'first'];
        },
      },
    };
    const ai = createAiClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: client });
    const models = await ai.listModels!();
    expect(models.map((m) => m.id)).toEqual(['claude-c', 'claude-b', 'claude-a']);
    expect(models[0]!.supports).toEqual({ adaptiveThinking: true, effort: false, fallbacks: false });
    // No display name: the id stands in.
    expect(models[1]!.display_name).toBe('claude-b');
    expect(seen).toHaveLength(2);
  });

  it('costs a call with the price given (override / price table); none = 0', async () => {
    const { client } = fake({});
    const ai = createAiClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: client });
    const out = await ai.complete({
      model: 'claude-new',
      messages: [{ role: 'user', content: 'x' }],
      price: { input: 10, output: 10, cacheRead: 1, cacheWrite: 12.5 },
    });
    // 1000 in + 200 out + 5000 cache read.
    expect(out.costUsd).toBeCloseTo(0.01 + 0.002 + 0.005, 6);
    const unpriced = await ai.complete({ model: 'claude-new', messages: [{ role: 'user', content: 'x' }] });
    expect(unpriced.costUsd).toBe(0);
  });
});

describe('agent requests (buildParams)', () => {
  it('asks current models for adaptive thinking, effort, caching and the refusal fallback', () => {
    const p = buildParams({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'x' }],
      effort: 'high',
      agentic: true,
      tools: [{ name: 't', input_schema: { type: 'object' } }],
    }) as unknown as Record<string, unknown>;
    expect(p).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral' },
      fallbacks: 'default',
      tool_choice: { type: 'auto' },
    });
  });

  it('leaves out what an older model does not take (Haiku 4.5)', () => {
    const p = buildParams({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'x' }],
      effort: 'high',
      agentic: true,
    }) as unknown as Record<string, unknown>;
    expect(p.thinking).toBeUndefined();
    expect(p.output_config).toBeUndefined();
    expect(p.fallbacks).toBeUndefined();
  });

  it('the scripted stand-in plays TOOL lines one per turn, then ends', async () => {
    const ai = createAiClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: scriptedAnthropic() });
    const prompt = 'do it\nTOOL get_board {"board_id":"b1"}';
    const first = await ai.complete({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: prompt }] });
    expect(first.stopReason).toBe('tool_use');
    expect(first.content.find((b) => b.type === 'tool_use')).toMatchObject({
      name: 'get_board',
      input: { board_id: 'b1' },
    });
    const second = await ai.complete({
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: first.content as Anthropic.ContentBlockParam[] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_scripted_0', content: '{}' }] },
      ],
    });
    expect(second.stopReason).toBe('end_turn');
  });

  it('the scripted stand-in answers ANSWER lines and reads the latest question of a chat', async () => {
    const ai = createAiClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: scriptedAnthropic() });
    const cell = await ai.complete({
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'user', content: ['<untrusted_content>', 'Name: ANSWER Hot', '</untrusted_content>'].join('\n') },
      ],
    });
    expect(cell.text).toBe('Hot');
    // A second question in the same chat plays its own script from turn 0.
    const chat = await ai.complete({
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: [{ type: 'text', text: 'Done (0 actions).' }] },
        { role: 'user', content: ['again', 'TOOL get_board {"board_id":"b2"}'].join('\n') },
      ],
    });
    expect(chat.content.find((b) => b.type === 'tool_use')).toMatchObject({ input: { board_id: 'b2' } });
  });

  it('streams text through onText when the client streams, and once otherwise', async () => {
    const deltas: string[] = [];
    const message = {
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'שלום עולם', citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Message;
    const streaming: AnthropicLike = {
      messages: {
        create: async () => message,
        stream: () => {
          let cb: (d: string) => void = () => {};
          return {
            on: (_e: 'text', fn: (d: string) => void) => {
              cb = fn;
            },
            finalMessage: async () => {
              cb('שלום ');
              cb('עולם');
              return message;
            },
          };
        },
      },
      models: { list: async () => ({ data: [] }) },
    };
    const ai = createAiClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: streaming });
    const out = await ai.complete({ model: 'claude-opus-5-5', messages: [], onText: (d) => deltas.push(d) });
    expect(deltas).toEqual(['שלום ', 'עולם']);
    expect(out.text).toBe('שלום עולם');
    const once: string[] = [];
    const plain = createAiClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: scriptedAnthropic() });
    await plain.complete({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'x' }],
      onText: (d) => once.push(d),
    });
    expect(once).toEqual(['Done (0 actions).']);
  });
});
