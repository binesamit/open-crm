// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { type AiPriceRule, resolveAiPrice } from '@bines/shared';
import { type AiClientFactory, createAiClient, type FetchLike, scriptedAnthropic } from '@bines/server-ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeWith } from '../src/modules/ai/ai.service';
import { clearModelCache } from '../src/modules/ai/models.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * AI to any provider and dynamic AI prices: OpenAI / OpenAI-compatible connections over a
 * mocked fetch (no network, no money), the owner's price table (API), the price precedence (connection override →
 * table exact → table pattern → unknown), the SSRF guard of a connection's base URL with the owner's "allow local
 * AI endpoints" switch, and the refusal of a model without tool calling wherever tools are needed (agents).
 */
let t: TestContext;
let owner: string;
let admin: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

/** A public address literal (no DNS in tests) for the OpenAI-compatible server. */
const COMPAT = 'https://93.184.216.34/v1';
const ROUTER = 'https://93.184.216.35/api/v1';
const sent: { url: string; body: Json | null }[] = [];
const reply = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const providerFetch: FetchLike = async (url, init) => {
  sent.push({ url, body: typeof init.body === 'string' ? (JSON.parse(init.body) as Json) : null });
  if (url === 'https://api.openai.com/v1/models')
    return reply({
      data: [
        { id: 'gpt-5', created: 1_760_000_000 },
        { id: 'gpt-5-mini', created: 1_750_000_000 },
        { id: 'gpt-4o', created: 1_700_000_000 },
      ],
    });
  // an OpenRouter-like server whose list prices every model (USD per token, as text).
  if (url === `${ROUTER}/models`)
    return reply({
      data: [
        {
          id: 'vendor/model-x',
          name: 'Vendor: Model X',
          created: 1_760_000_000,
          supported_parameters: ['tools'],
          pricing: { prompt: '0.000002', completion: '0.00001' },
        },
      ],
    });
  if (url.endsWith('/chat/completions')) {
    const req = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Json;
    return reply({
      model: req.model,
      choices: [{ message: { content: `answer from ${req.model}` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 200 } },
    });
  }
  // An OpenAI-compatible server without a model list: the connection's hand-added models stand in.
  return reply({ error: { message: 'not found' } }, 404);
};
const aiClient: AiClientFactory = (conn) =>
  createAiClient(conn, { anthropic: scriptedAnthropic(), fetch: providerFetch });

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);

beforeAll(async () => {
  clearModelCache();
  t = await createTestContext({ aiClient });
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id as string;
  admin = await join('admin@acme.test');
  expect((await as(admin).patch('/ai/settings', { enabled: true })).status).toBe(200);
});
afterAll(() => t.close());

describe('price precedence (pure)', () => {
  const table: AiPriceRule[] = [
    { provider: 'openai', model: 'gpt-5*', input: 1, output: 4, cache_read: null, cache_write: null },
    { provider: 'openai', model: 'gpt-5-mini*', input: 0.5, output: 2, cache_read: 0.05, cache_write: null },
    { provider: 'openai', model: 'gpt-5-mini', input: 0.25, output: 2, cache_read: null, cache_write: null },
    { provider: '*', model: 'gpt-5-nano', input: 9, output: 9, cache_read: null, cache_write: null },
    { provider: '*', model: 'llama*', input: 0.1, output: 0.2, cache_read: null, cache_write: null },
  ];
  it('override → exact (this provider before *) → longest pattern → unknown', () => {
    expect(resolveAiPrice('openai', 'gpt-5-mini', { 'gpt-5-mini': { input: 7, output: 8 } }, table)).toMatchObject({
      source: 'override',
      price: { input: 7, output: 8, cacheRead: 7, cacheWrite: 7 },
    });
    expect(resolveAiPrice('openai', 'gpt-5-mini', null, table)).toMatchObject({
      source: 'table',
      rule: 'gpt-5-mini',
      price: { input: 0.25, cacheRead: 0.25 },
    });
    // Exact (any provider) beats a pattern of this provider.
    expect(resolveAiPrice('openai', 'gpt-5-nano', null, table)!.rule).toBe('gpt-5-nano');
    // The most specific pattern wins.
    expect(resolveAiPrice('openai', 'gpt-5-mini-2026', null, table)).toMatchObject({
      rule: 'gpt-5-mini*',
      price: { input: 0.5, cacheRead: 0.05, cacheWrite: 0.5 },
    });
    expect(resolveAiPrice('openai', 'gpt-5.1', null, table)!.rule).toBe('gpt-5*');
    expect(resolveAiPrice('openai_compatible', 'llama3.1:8b', null, table)!.rule).toBe('llama*');
    // A pattern of another provider does not apply; nothing matches = unknown.
    expect(resolveAiPrice('gemini', 'gpt-5.1', null, table)).toBeNull();
    expect(resolveAiPrice('openai', 'gpt-4o', null, table)).toBeNull();
    // the provider list's own price (OpenRouter) is the last fallback, never above the table.
    const listed = { input: 3, output: 15, cache_read: 0.3 };
    expect(resolveAiPrice('openai', 'gpt-4o', null, table, listed)).toMatchObject({
      source: 'provider',
      rule: null,
      price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
    });
    expect(resolveAiPrice('openai', 'gpt-5-mini', null, table, listed)!.source).toBe('table');
    expect(
      resolveAiPrice('openai', 'gpt-5-mini', { 'gpt-5-mini': { input: 7, output: 8 } }, table, listed)!.source,
    ).toBe('override');
  });
});

describe('owner console: the AI price table', () => {
  let patternId = '';
  let exactId = '';
  it('is seeded with the prices that used to be in code', async () => {
    const res = await t.api(owner).get('/platform/ai-prices');
    expect(res.status).toBe(200);
    const rows = (await body(res)).data as Json[];
    expect(rows.find((r) => r.model === 'claude-opus-5-5')).toMatchObject({
      provider: 'anthropic',
      input: 4,
      output: 20,
      cache_read: 0.2,
      cache_write: 5,
      currency: 'USD',
    });
    // AI images seeds OpenAI's image models too.
    expect(rows.map((r) => r.model).sort()).toEqual([
      'claude-haiku-4-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'dall-e-3',
      'gpt-image-1',
    ]);
  });

  it('only the platform owner may read or edit it', async () => {
    expect((await t.api(admin).get('/platform/ai-prices')).status).toBe(404);
    expect(
      (await t.api(admin).post('/platform/ai-prices', { provider: 'openai', model: 'x', input: 1, output: 1 })).status,
    ).toBe(404);
  });

  it('adds, refuses duplicates and bad patterns, changes and removes prices', async () => {
    const add = await t.api(owner).post('/platform/ai-prices', {
      provider: 'openai',
      model: 'gpt-5*',
      input: 1,
      output: 3,
      cache_read: 0.1,
      note: 'GPT-5 family',
    });
    expect(add.status).toBe(201);
    const row = await body(add);
    patternId = row.id;
    expect(row).toMatchObject({ model: 'gpt-5*', cache_read: 0.1, cache_write: null, note: 'GPT-5 family' });
    expect(
      (await t.api(owner).post('/platform/ai-prices', { provider: 'openai', model: 'GPT-5*', input: 1, output: 1 }))
        .status,
    ).toBe(409);
    expect(
      (await t.api(owner).post('/platform/ai-prices', { provider: 'openai', model: 'gpt 5', input: 1, output: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await t.api(owner).post('/platform/ai-prices', { provider: 'acme-ai', model: 'm', input: 1, output: 1 })).status,
    ).toBe(400);
    const patched = await t.api(owner).patch(`/platform/ai-prices/${patternId}`, { output: 4 });
    expect(patched.status).toBe(200);
    expect((await body(patched)).output).toBe(4);
    const exact = await t.api(owner).post('/platform/ai-prices', {
      provider: 'openai',
      model: 'gpt-5-mini',
      input: 0.25,
      output: 2,
    });
    exactId = (await body(exact)).id;
    const temp = await body(
      await t.api(owner).post('/platform/ai-prices', { provider: '*', model: 'temp*', input: 1, output: 1 }),
    );
    expect((await t.api(owner).del(`/platform/ai-prices/${temp.id}`)).status).toBe(200);
    expect((await t.api(owner).del(`/platform/ai-prices/${temp.id}`)).status).toBe(404);
    expect(exactId).toBeTruthy();
  });
});

describe('an OpenAI connection: live models, prices from the table, cost from usage', () => {
  let conn = '';
  it('a key is required for OpenAI; the live list is read with it', async () => {
    const noKey = await as(admin).post('/ai/connections', { name: 'OpenAI', provider: 'openai' });
    expect(noKey.status).toBe(422);
    expect((await body(noKey)).error.message).toBe('ai_key_required');
    const res = await as(admin).post('/ai/connections', {
      name: 'OpenAI',
      provider: 'openai',
      api_key: 'sk-openai-test-000000',
      default_model: 'gpt-5',
    });
    expect(res.status).toBe(201);
    const c = await body(res);
    conn = c.id;
    expect(c).toMatchObject({ provider: 'openai', base_url: null, manual_models: [], default_model: 'gpt-5' });
    expect(JSON.stringify(c)).not.toContain('sk-openai');
  });

  it('lists models with price and source: override → table exact → table pattern → unknown', async () => {
    await as(admin).patch(`/ai/connections/${conn}`, { price_overrides: { 'gpt-4o': null } });
    const list = await body(await as(admin).get(`/ai/connections/${conn}/models`));
    expect(list.source).toBe('live');
    const by = Object.fromEntries((list.data as Json[]).map((m) => [m.id, m]));
    expect(by['gpt-5']).toMatchObject({ price: { input: 1, output: 4 }, price_source: 'table', default: true });
    expect(by['gpt-5-mini']).toMatchObject({ price: { input: 0.25, output: 2 }, price_source: 'table' });
    expect(by['gpt-4o']).toMatchObject({ price: null, price_source: null });
    expect(by['gpt-5'].capabilities).toEqual({
      tools: true,
      vision: true,
      json: true,
      streaming: true,
      max_context: null,
      image_generation: false,
    });
    // The connection's own price wins over the table.
    await as(admin).patch(`/ai/connections/${conn}`, { price_overrides: { 'gpt-5-mini': { input: 9, output: 9 } } });
    const again = await body(await as(admin).get(`/ai/connections/${conn}/models`));
    expect((again.data as Json[]).find((m) => m.id === 'gpt-5-mini')).toMatchObject({
      price: { input: 9, output: 9 },
      price_source: 'override',
    });
  });

  it('a call is costed from its real usage with the table price; an unknown price costs 0 and is flagged', async () => {
    const out = await completeWith(t.deps, acmeId, conn, 'test', {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.text).toBe('answer from gpt-5');
    // 1000 prompt (200 cached at $0.1) + 100 output at the gpt-5* pattern's $1 / $4.
    expect(out.costUsd).toBeCloseTo((800 * 1 + 200 * 0.1 + 100 * 4) / 1_000_000, 9);
    expect(sent.at(-1)!.body).toMatchObject({ model: 'gpt-5', max_completion_tokens: 16000 });
    const unknown = await completeWith(t.deps, acmeId, conn, 'test', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(unknown.costUsd).toBe(0);
    const usage = await body(await as(admin).get('/ai/usage'));
    expect((usage.rows as Json[]).find((r) => r.model === 'gpt-4o')).toMatchObject({ price_known: false, cost_usd: 0 });
    expect((usage.rows as Json[]).find((r) => r.model === 'gpt-5')).toMatchObject({ price_known: true });
    expect(usage.unpriced_models).toEqual([{ connection_id: conn, connection_name: 'OpenAI', model: 'gpt-4o' }]);
  });
});

describe('a server whose model list has prices (OpenRouter)', () => {
  it('shows the listed price, costs a call with it and counts the model as priced', async () => {
    const res = await as(admin).post('/ai/connections', {
      name: 'Router',
      provider: 'openai_compatible',
      base_url: ROUTER,
      api_key: 'sk-or-test-0000000000',
      default_model: 'vendor/model-x',
    });
    expect(res.status).toBe(201);
    const conn = (await body(res)).id as string;
    const list = await body(await as(admin).get(`/ai/connections/${conn}/models`));
    expect((list.data as Json[]).find((m) => m.id === 'vendor/model-x')).toMatchObject({
      display_name: 'Vendor: Model X',
      price: { input: 2, output: 10 },
      price_source: 'provider',
    });
    const out = await completeWith(t.deps, acmeId, conn, 'test', {
      model: 'vendor/model-x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // 1000 prompt tokens (200 of them cached — no cache price listed: the input price) + 100 output.
    expect(out.costUsd).toBeCloseTo((1000 * 2 + 100 * 10) / 1_000_000, 9);
    const usage = await body(await as(admin).get('/ai/usage'));
    expect((usage.rows as Json[]).find((r) => r.model === 'vendor/model-x')).toMatchObject({ price_known: true });
  });
});

describe('an OpenAI-compatible connection: base URL guard, hand-added models, capabilities', () => {
  let compat = '';
  it('a private base URL is refused until the owner allows local AI endpoints', async () => {
    const local = { name: 'Ollama', provider: 'openai_compatible', base_url: 'http://127.0.0.1:11434/v1' };
    const refused = await as(admin).post('/ai/connections', local);
    expect(refused.status).toBe(422);
    expect((await body(refused)).error.message).toBe('ai_base_url_private');
    expect((await as(admin).post('/ai/connections', { ...local, base_url: undefined })).status).toBe(422);
    // Only the platform owner switches it on.
    expect((await t.api(admin).patch('/platform/settings', { ai: { allow_local_endpoints: true } })).status).toBe(404);
    const on = await t.api(owner).patch('/platform/settings', { ai: { allow_local_endpoints: true } });
    expect((await body(on)).settings.ai).toEqual({ allow_local_endpoints: true, local_endpoint_origins: [] });
    const allowed = await as(admin).post('/ai/connections', {
      ...local,
      manual_models: [{ id: 'llama3.1' }],
      default_model: 'llama3.1',
    });
    expect(allowed.status).toBe(201);
    expect((await body(allowed)).key_hint).toBe('—');
    await t.api(owner).patch('/platform/settings', { ai: { allow_local_endpoints: false } });
  });

  it('or only the origins the owner names (audit 2026-10-10 #19): that server yes, the rest of the network no', async () => {
    const listed = await t.api(owner).patch('/platform/settings', {
      ai: { local_endpoint_origins: ['http://127.0.0.1:11434', 'https://Ollama.Internal:8443'] },
    });
    expect((await body(listed)).settings.ai).toEqual({
      allow_local_endpoints: false,
      local_endpoint_origins: ['http://127.0.0.1:11434', 'https://ollama.internal:8443'],
    });
    expect(
      (await t.api(owner).patch('/platform/settings', { ai: { local_endpoint_origins: ['http://10.0.0.5/v1'] } }))
        .status,
    ).toBe(400); // a path is not an origin
    const ok = await as(admin).post('/ai/connections', {
      name: 'Ollama listed',
      provider: 'openai_compatible',
      base_url: 'http://127.0.0.1:11434/v1',
      manual_models: [{ id: 'llama3.1' }],
      default_model: 'llama3.1',
    });
    expect(ok.status).toBe(201);
    const other = await as(admin).post('/ai/connections', {
      name: 'Elsewhere',
      provider: 'openai_compatible',
      base_url: 'http://127.0.0.1:11435/v1',
      manual_models: [{ id: 'x' }],
      default_model: 'x',
    });
    expect(other.status).toBe(422);
    expect((await body(other)).error.message).toBe('ai_base_url_private');
    await t.api(owner).patch('/platform/settings', { ai: { local_endpoint_origins: [] } });
  });

  it('a server without a model list: hand-added models with their capabilities', async () => {
    const res = await as(admin).post('/ai/connections', {
      name: 'Groq-like',
      provider: 'openai_compatible',
      api_key: 'gsk-test-0000000000',
      base_url: COMPAT,
      manual_models: [
        { id: 'tiny', display_name: 'Tiny', capabilities: { tools: false, max_context: 8192 } },
        { id: 'big' },
      ],
      default_model: 'big',
    });
    expect(res.status).toBe(201);
    compat = (await body(res)).id;
    const list = await body(await as(admin).get(`/ai/connections/${compat}/models`));
    expect(list.source).toBe('fallback');
    const by = Object.fromEntries((list.data as Json[]).map((m) => [m.id, m]));
    expect(by.tiny).toMatchObject({
      display_name: 'Tiny',
      manual: true,
      capabilities: { tools: false, vision: false, streaming: true, max_context: 8192 },
    });
    expect(by.big.capabilities.tools).toBe(true);
    // Not on the list and not added by hand.
    expect((await as(admin).patch(`/ai/connections/${compat}`, { default_model: 'ghost' })).status).toBe(422);
  });

  it('agents refuse a model without tool calling, with a clear reason', async () => {
    const refused = await as(admin).post('/agents', { name: 'סוכן', connection_id: compat, model: 'tiny' });
    expect(refused.status).toBe(422);
    expect((await body(refused)).error.message).toBe('ai_model_no_tools');
    expect((await as(admin).post('/agents', { name: 'סוכן', connection_id: compat, model: 'big' })).status).toBe(201);
  });

  it('every feature that hands tools to the model refuses it too; plain calls work', async () => {
    const tools: Anthropic.Tool[] = [{ name: 'get_board', input_schema: { type: 'object' } }];
    await expect(
      completeWith(t.deps, acmeId, compat, 'assistant', {
        model: 'tiny',
        tools,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow('ai_model_no_tools');
    const plain = await completeWith(t.deps, acmeId, compat, 'column', {
      model: 'tiny',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(plain.text).toBe('answer from tiny');
    expect(sent.at(-1)).toMatchObject({ url: `${COMPAT}/chat/completions`, body: { max_tokens: 16000 } });
    // Marking the model as able to call tools (the admin's correction) lets it through.
    await as(admin).patch(`/ai/connections/${compat}`, {
      manual_models: [{ id: 'tiny', capabilities: { tools: true } }, { id: 'big' }],
    });
    const withTools = await completeWith(t.deps, acmeId, compat, 'assistant', {
      model: 'tiny',
      tools,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(withTools.stopReason).toBe('end_turn');
  });

  it('a new base URL is guarded like a new connection', async () => {
    const res = await as(admin).patch(`/ai/connections/${compat}`, { base_url: 'http://169.254.169.254/v1' });
    expect(res.status).toBe(422);
    expect((await body(res)).error.message).toBe('ai_base_url_private');
  });
});
