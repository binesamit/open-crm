// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { type AiCompletionRequest, createAiClient, type FetchLike, safeAiError } from '../src';

/**
 * Provider adapters: OpenAI, Google Gemini and OpenAI-compatible servers, over a mocked fetch — no
 * network, no money. Each one: a completion, tool calls both ways, streaming, usage → cost, the model list, errors.
 */
type Seen = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };

const mockFetch = (answer: (url: string, body: Record<string, unknown> | null) => Response) => {
  const seen: Seen[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    seen.push({ url, method: init.method, headers: init.headers, body });
    return answer(url, body);
  };
  return { fetchFn, seen };
};

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const PRICE = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 };
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_board',
    description: 'Read a board',
    input_schema: { type: 'object', properties: { id: { type: 'string' } } },
  },
];
/** A conversation that already had one tool round: the adapters must send the call and its result back. */
const HISTORY: Anthropic.MessageParam[] = [
  { role: 'user', content: 'What is on board b1?' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '', signature: 's' } as Anthropic.ThinkingBlockParam,
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'call_1', name: 'get_board', input: { id: 'b1' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"items":3}' }] },
];
const req = (extra: Partial<AiCompletionRequest> = {}): AiCompletionRequest => ({
  model: 'm',
  system: 'Be brief.',
  messages: HISTORY,
  tools: TOOLS,
  price: PRICE,
  maxTokens: 500,
  ...extra,
});

describe('OpenAI adapter', () => {
  const answer = {
    model: 'gpt-5-2026',
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'get_board', arguments: '{"id":"b2"}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } },
  };

  it('maps the request (system, tool calls, tool results, tools) and the answer (tool_use, usage → cost)', async () => {
    const { fetchFn, seen } = mockFetch(() => json(answer));
    const ai = createAiClient({ provider: 'openai', apiKey: 'sk-oa' }, { fetch: fetchFn });
    const out = await ai.complete(req({ model: 'gpt-5', effort: 'max' }));
    const call = seen[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer sk-oa');
    expect(call.body).toMatchObject({
      model: 'gpt-5',
      max_completion_tokens: 500,
      tool_choice: 'auto',
      reasoning_effort: 'high',
      tools: [{ type: 'function', function: { name: 'get_board', parameters: TOOLS[0]!.input_schema } }],
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'What is on board b1?' },
        {
          role: 'assistant',
          content: 'Let me look.',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_board', arguments: '{"id":"b1"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"items":3}' },
      ],
    });
    expect(out.stopReason).toBe('tool_use');
    expect(out.content).toEqual([{ type: 'tool_use', id: 'call_2', name: 'get_board', input: { id: 'b2' } }]);
    // 1000 prompt tokens of which 400 cached: 600 input + 400 cache reads + 100 output.
    expect(out.usage).toEqual({
      input_tokens: 600,
      output_tokens: 100,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 0,
    });
    expect(out.costUsd).toBeCloseTo((600 * 2 + 400 * 0.5 + 100 * 8) / 1_000_000, 9);
    expect(out.model).toBe('gpt-5-2026');
  });

  it('a plain answer ends the turn; length = max_tokens; content_filter = refusal', async () => {
    for (const [finish, stop] of [
      ['stop', 'end_turn'],
      ['length', 'max_tokens'],
      ['content_filter', 'refusal'],
    ] as const) {
      const { fetchFn } = mockFetch(() =>
        json({ choices: [{ message: { content: 'שלום' }, finish_reason: finish }], usage: { prompt_tokens: 1 } }),
      );
      const out = await createAiClient({ provider: 'openai', apiKey: 'k' }, { fetch: fetchFn }).complete(
        req({ model: 'gpt-4o', tools: undefined }),
      );
      expect(out.stopReason).toBe(stop);
      expect(out.text).toBe(stop === 'refusal' ? '' : 'שלום');
    }
  });

  it('streams text deltas and assembles streamed tool calls', async () => {
    const { fetchFn, seen } = mockFetch(() =>
      sse([
        { model: 'gpt-5', choices: [{ delta: { content: 'של' } }] },
        { choices: [{ delta: { content: 'ום' } }] },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'get_', arguments: '{"i' } }] } }],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'board', arguments: 'd":"x"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } },
        '[DONE]',
      ]),
    );
    const deltas: string[] = [];
    const out = await createAiClient({ provider: 'openai', apiKey: 'k' }, { fetch: fetchFn }).complete(
      req({ model: 'gpt-5', onText: (d) => deltas.push(d) }),
    );
    expect(seen[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(deltas).toEqual(['של', 'ום']);
    expect(out.text).toBe('שלום');
    expect(out.content).toEqual([
      { type: 'text', text: 'שלום', citations: null },
      { type: 'tool_use', id: 'c9', name: 'get_board', input: { id: 'x' } },
    ]);
    expect(out.usage.input_tokens).toBe(50);
    expect(out.costUsd).toBeCloseTo((50 * 2 + 5 * 8) / 1_000_000, 9);
  });

  it('a model that cannot stream answers once, at the end', async () => {
    const { fetchFn, seen } = mockFetch(() =>
      json({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }),
    );
    const deltas: string[] = [];
    await createAiClient({ provider: 'openai', apiKey: 'k' }, { fetch: fetchFn }).complete(
      req({ onText: (d) => deltas.push(d), stream: false }),
    );
    expect(seen[0]!.body!.stream).toBeUndefined();
    expect(deltas).toEqual(['x']);
  });

  it('lists chat models only, newest first; test() maps HTTP errors to safe codes', async () => {
    const { fetchFn } = mockFetch(() =>
      json({
        data: [
          { id: 'gpt-4o', created: 1_700_000_000 },
          { id: 'text-embedding-3-large', created: 1_800_000_000 },
          { id: 'gpt-5', created: 1_750_000_000 },
          { id: 'whisper-1', created: 1 },
        ],
      }),
    );
    const ai = createAiClient({ provider: 'openai', apiKey: 'k' }, { fetch: fetchFn });
    expect((await ai.listModels!()).map((m) => m.id)).toEqual(['gpt-5', 'gpt-4o']);
    expect(await ai.test()).toEqual({ ok: true, error: null });
    const bad = createAiClient(
      { provider: 'openai', apiKey: 'k' },
      { fetch: mockFetch(() => json({ error: { message: 'Incorrect API key sk-…' } }, 401)).fetchFn },
    );
    expect(await bad.test()).toEqual({ ok: false, error: 'invalid_api_key' });
    const limited = mockFetch(() => json({}, 429)).fetchFn;
    await expect(
      createAiClient({ provider: 'openai', apiKey: 'k' }, { fetch: limited }).complete(req()),
    ).rejects.toSatisfy((e) => safeAiError(e) === 'rate_limited');
  });
});

describe('OpenAI-compatible adapter', () => {
  it('calls the base URL, sends no key when there is none, and uses max_tokens', async () => {
    const { fetchFn, seen } = mockFetch(() =>
      json({
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    );
    const ai = createAiClient(
      { provider: 'openai_compatible', apiKey: '', baseUrl: 'http://ollama.example:11434/v1/' },
      { fetch: fetchFn },
    );
    const out = await ai.complete(req({ model: 'llama3.1', effort: 'high' }));
    expect(seen[0]!.url).toBe('http://ollama.example:11434/v1/chat/completions');
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.body).toMatchObject({ max_tokens: 500 });
    expect(seen[0]!.body!.reasoning_effort).toBeUndefined();
    expect(out.text).toBe('hi');
    expect(out.costUsd).toBeCloseTo((10 * 2 + 2 * 8) / 1_000_000, 9);
  });

  it('reads what a rich model list says (OpenRouter): context, tools, images', async () => {
    const { fetchFn, seen } = mockFetch(() =>
      json({
        data: [
          {
            id: 'mistralai/mistral-large',
            name: 'Mistral Large',
            context_length: 128000,
            supported_parameters: ['tools', 'temperature'],
            architecture: { input_modalities: ['text'] },
          },
          { id: 'some/plain', supported_parameters: ['temperature'] },
        ],
      }),
    );
    const ai = createAiClient(
      { provider: 'openai_compatible', apiKey: 'or-key', baseUrl: 'https://openrouter.example/api/v1' },
      { fetch: fetchFn },
    );
    const models = await ai.listModels!();
    expect(seen[0]!.url).toBe('https://openrouter.example/api/v1/models');
    expect(models.find((m) => m.id === 'mistralai/mistral-large')).toMatchObject({
      display_name: 'Mistral Large',
      capabilities: { max_context: 128000, tools: true, vision: false },
    });
    expect(models.find((m) => m.id === 'some/plain')!.capabilities).toEqual({ tools: false });
  });

  it('reads the price a model list gives (OpenRouter: USD per token as text) as USD per 1M tokens', async () => {
    const { fetchFn } = mockFetch(() =>
      json({
        data: [
          {
            id: 'anthropic/claude-haiku',
            name: 'Anthropic: Claude Haiku',
            pricing: { prompt: '0.000001', completion: '0.000005', input_cache_read: '0.0000001' },
          },
          // OpenRouter's router: -1 = the price varies — no price.
          { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
          { id: 'free/model', pricing: { prompt: '0', completion: '0' } },
          { id: 'no/price' },
        ],
      }),
    );
    const ai = createAiClient(
      { provider: 'openai_compatible', apiKey: 'or-key', baseUrl: 'https://openrouter.example/api/v1' },
      { fetch: fetchFn },
    );
    const models = await ai.listModels!();
    expect(models.find((m) => m.id === 'anthropic/claude-haiku')!.price).toEqual({
      input: 1,
      output: 5,
      cache_read: 0.1,
      cache_write: null,
    });
    expect(models.find((m) => m.id === 'openrouter/auto')!.price).toBeUndefined();
    expect(models.find((m) => m.id === 'free/model')!.price).toMatchObject({ input: 0, output: 0 });
    expect(models.find((m) => m.id === 'no/price')!.price).toBeUndefined();
  });
});

describe('Gemini adapter', () => {
  it('maps the request (systemInstruction, functionCall / functionResponse by name) and the answer', async () => {
    const { fetchFn, seen } = mockFetch(() =>
      json({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'thinking…', thought: true },
                { text: 'Checking.' },
                { functionCall: { name: 'get_board', args: { id: 'b2' } }, thoughtSignature: 'sig-1' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 1000,
          cachedContentTokenCount: 200,
          candidatesTokenCount: 50,
          thoughtsTokenCount: 30,
        },
        modelVersion: 'gemini-3-pro',
      }),
    );
    const ai = createAiClient({ provider: 'gemini', apiKey: 'g-key' }, { fetch: fetchFn });
    const out = await ai.complete(req({ model: 'gemini-3-pro' }));
    const call = seen[0]!;
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent');
    expect(call.headers['x-goog-api-key']).toBe('g-key');
    expect(call.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      generationConfig: { maxOutputTokens: 500 },
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      tools: [{ functionDeclarations: [{ name: 'get_board', parametersJsonSchema: TOOLS[0]!.input_schema }] }],
      contents: [
        { role: 'user', parts: [{ text: 'What is on board b1?' }] },
        {
          role: 'model',
          parts: [{ text: 'Let me look.' }, { functionCall: { id: 'call_1', name: 'get_board', args: { id: 'b1' } } }],
        },
        {
          role: 'user',
          parts: [{ functionResponse: { id: 'call_1', name: 'get_board', response: { result: '{"items":3}' } } }],
        },
      ],
    });
    expect(out.stopReason).toBe('tool_use');
    expect(out.text).toBe('Checking.');
    const use = out.content.find((b) => b.type === 'tool_use') as Anthropic.ToolUseBlock & {
      thought_signature?: string;
    };
    expect(use).toMatchObject({ name: 'get_board', input: { id: 'b2' }, thought_signature: 'sig-1' });
    // Thinking tokens count as output; cached prompt tokens as cache reads.
    expect(out.usage).toEqual({
      input_tokens: 800,
      output_tokens: 80,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 0,
    });
    expect(out.costUsd).toBeCloseTo((800 * 2 + 200 * 0.5 + 80 * 8) / 1_000_000, 9);

    // The next turn sends the call back with its signature, and answers it by the tool's name.
    const next: Anthropic.MessageParam[] = [
      ...HISTORY,
      { role: 'assistant', content: out.content as Anthropic.ContentBlockParam[] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'nope', is_error: true }] },
    ];
    await ai.complete(req({ model: 'gemini-3-pro', messages: next }));
    const contents = seen[1]!.body!.contents as { parts: Record<string, unknown>[] }[];
    expect(contents.at(-2)!.parts.at(-1)).toEqual({
      functionCall: { name: 'get_board', args: { id: 'b2' } },
      thoughtSignature: 'sig-1',
    });
    expect(contents.at(-1)!.parts[0]).toEqual({ functionResponse: { name: 'get_board', response: { error: 'nope' } } });
  });

  it('safety blocks are refusals; MAX_TOKENS is max_tokens; streaming sends deltas', async () => {
    const blocked = mockFetch(() => json({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] })).fetchFn;
    const ai = createAiClient({ provider: 'gemini', apiKey: 'k' }, { fetch: blocked });
    expect((await ai.complete(req({ tools: undefined }))).stopReason).toBe('refusal');
    const long = mockFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'MAX_TOKENS' }] }),
    ).fetchFn;
    expect(
      (await createAiClient({ provider: 'gemini', apiKey: 'k' }, { fetch: long }).complete(req())).stopReason,
    ).toBe('max_tokens');
    const { fetchFn, seen } = mockFetch(() =>
      sse([
        { candidates: [{ content: { parts: [{ text: 'של' }] } }] },
        {
          candidates: [{ content: { parts: [{ text: 'ום' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
        },
      ]),
    );
    const deltas: string[] = [];
    const out = await createAiClient({ provider: 'gemini', apiKey: 'k' }, { fetch: fetchFn }).complete(
      req({ model: 'gemini-2.5-flash', onText: (d) => deltas.push(d) }),
    );
    expect(seen[0]!.url).toContain(':streamGenerateContent?alt=sse');
    expect(deltas).toEqual(['של', 'ום']);
    expect(out).toMatchObject({ text: 'שלום', stopReason: 'end_turn', usage: { input_tokens: 9, output_tokens: 2 } });
  });

  it('lists generateContent models with their context window', async () => {
    const { fetchFn } = mockFetch(() =>
      json({
        models: [
          {
            name: 'models/gemini-2.5-pro',
            displayName: 'Gemini 2.5 Pro',
            inputTokenLimit: 1048576,
            supportedGenerationMethods: ['generateContent'],
          },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    );
    const models = await createAiClient({ provider: 'gemini', apiKey: 'k' }, { fetch: fetchFn }).listModels!();
    expect(models).toEqual([
      {
        id: 'gemini-2.5-pro',
        display_name: 'Gemini 2.5 Pro',
        created_at: null,
        capabilities: { max_context: 1048576 },
      },
    ]);
  });
});
