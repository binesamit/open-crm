// SPDX-License-Identifier: AGPL-3.0-only
import { modelVersion, rankModels } from '@bines/shared';
import { type AiClientFactory, createAiClient, type FetchLike, scriptedAnthropic } from '@bines/server-ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeWith } from '../src/modules/ai/ai.service';
import { clearModelCache } from '../src/modules/ai/models.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Dynamic models for every provider (product owner, round 2: "the models must be dynamic like Claude's —
 * Gemini, OpenAI…"). Over a mocked fetch (no network, no money): OpenAI, Gemini and an OpenAI-compatible server each
 * list their own models — that list (plus hand-added models) is what every picker reads (agents, the assistant, AI
 * columns, AI images, the flows AI all read `GET /ai/connections/:id/models`), ranked newest / most capable first,
 * with "unknown" prices shown rather than hidden; the default model comes from the list (never a Claude id) and a
 * refresh brings new models in at once, while a failing provider keeps its last list.
 */
let t: TestContext;
let owner: string;
let admin: string;
let member: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const COMPAT = 'https://93.184.216.34/v1';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const day = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** The providers' lists — tests change them to see a refresh. */
const openaiModels: Json[] = [
  { id: 'gpt-4o', created: day('2024-05-13T00:00:00Z') },
  { id: 'gpt-5-mini', created: day('2025-08-07T00:00:20Z') },
  { id: 'gpt-5', created: day('2025-08-07T00:00:10Z') },
  { id: 'gpt-image-1', created: day('2025-04-23T00:00:00Z') },
  { id: 'text-embedding-3-large', created: day('2024-01-25T00:00:00Z') },
];
let openaiDown = false;
const geminiModels: Json[] = [
  { name: 'models/gemini-1.5-flash', displayName: 'Gemini 1.5 Flash', supportedGenerationMethods: ['generateContent'] },
  {
    name: 'models/gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    inputTokenLimit: 1_048_576,
    supportedGenerationMethods: ['generateContent'],
  },
  {
    name: 'models/gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    inputTokenLimit: 1_048_576,
    supportedGenerationMethods: ['generateContent'],
  },
  {
    name: 'models/gemini-3-pro-preview',
    displayName: 'Gemini 3 Pro Preview',
    supportedGenerationMethods: ['generateContent'],
  },
  { name: 'models/gemma-3-27b-it', displayName: 'Gemma 3 27B', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/imagen-4.0-generate-001', displayName: 'Imagen 4', supportedGenerationMethods: ['predict'] },
  { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
];
const compatModels: Json[] = [
  { id: 'meta/llama-3.1-8b', created: day('2024-07-23T00:00:00Z'), supported_parameters: ['tools'] },
  {
    id: 'mistral/mistral-large-2411',
    name: 'Mistral Large',
    created: day('2024-11-18T00:00:00Z'),
    context_length: 128_000,
    supported_parameters: ['tools', 'temperature'],
  },
  { id: 'acme/no-tools', created: day('2025-01-01T00:00:00Z'), supported_parameters: ['temperature'] },
];

const sent: { url: string; body: Json | null }[] = [];
const reply = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const chat = (req: Json) =>
  reply({
    model: req.model,
    choices: [{ message: { content: `answer from ${req.model}` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
const providerFetch: FetchLike = async (url, init) => {
  const req = typeof init.body === 'string' ? (JSON.parse(init.body) as Json) : null;
  sent.push({ url, body: req });
  if (url === 'https://api.openai.com/v1/models')
    return openaiDown ? reply({ error: { message: 'down' } }, 503) : reply({ data: openaiModels });
  if (url.startsWith(`${GEMINI}/models?`)) return reply({ models: geminiModels });
  if (url === `${COMPAT}/models`) return reply({ data: compatModels });
  if (url.endsWith('/chat/completions')) return chat(req ?? {});
  if (url.startsWith(`${GEMINI}/models/`) && url.includes(':generateContent'))
    return reply({
      candidates: [{ content: { parts: [{ text: 'gemini answer' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    });
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
const ids = (list: Json) => (list.data as Json[]).map((m) => m.id as string);
const models = async (conn: string, refresh = false) =>
  body(await as(admin).get(`/ai/connections/${conn}/models${refresh ? '?refresh=true' : ''}`));
const say = [{ role: 'user' as const, content: 'hi' }];

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
  await as(admin).post('/users/invite', { emails: ['member@acme.test'], role: 'member' });
  member = await join('member@acme.test');
  expect((await as(admin).patch('/ai/settings', { enabled: true })).status).toBe(200);
});
afterAll(() => t.close());

describe('ranking (pure)', () => {
  it('reads the version in a model name', () => {
    expect(modelVersion('gemini-2.5-pro')).toBe(2.5);
    expect(modelVersion('claude-opus-4-5-20251101')).toBe(4.5);
    expect(modelVersion('gpt-4o')).toBe(4);
    expect(modelVersion('gpt-4.1-mini')).toBe(4.1);
    expect(modelVersion('llama3.1:8b')).toBe(3.1);
    expect(modelVersion('gemma-3-27b-it')).toBe(3);
    expect(modelVersion('gemini-exp-1206')).toBe(0);
  });

  it('tool-calling models first, newest first (date, else version), flagship before small, stable before preview', () => {
    const caps = (tools: boolean, image_generation = false) => ({ tools, image_generation });
    const ranked = rankModels([
      { id: 'b-1-flash', created_at: null, capabilities: caps(true) },
      { id: 'b-2-flash', created_at: null, capabilities: caps(true) },
      { id: 'b-2-pro', created_at: null, capabilities: caps(true) },
      { id: 'b-2-pro-preview', created_at: null, capabilities: caps(true) },
      { id: 'b-image', created_at: null, capabilities: caps(false, true) },
      { id: 'b-small', created_at: null, capabilities: caps(false) },
      { id: 'dated-old', created_at: '2024-01-01T00:00:00Z', capabilities: caps(true) },
      { id: 'dated-new', created_at: '2025-01-01T00:00:00Z', capabilities: caps(true) },
    ]);
    expect(ranked.map((m) => m.id)).toEqual([
      'dated-new',
      'dated-old',
      'b-2-pro',
      'b-2-pro-preview',
      'b-2-flash',
      'b-1-flash',
      'b-small',
      'b-image',
    ]);
  });
});

describe('OpenAI: the live list drives the pickers and the default', () => {
  let conn = '';
  it('a connection without a default model: the newest tool-calling model of the list is its default', async () => {
    const res = await as(admin).post('/ai/connections', {
      name: 'OpenAI',
      provider: 'openai',
      api_key: 'sk-openai-test-000000',
    });
    expect(res.status).toBe(201);
    const created = await body(res);
    conn = created.id;
    expect(created.default_model).toBeNull();
    const list = await models(conn);
    expect(list.source).toBe('live');
    // Newest first, the flagship before the small model of the same day; image models last; no embeddings.
    expect(ids(list)).toEqual(['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-image-1']);
    expect(ids(list).some((id) => id.startsWith('claude'))).toBe(false);
    expect(list).toMatchObject({ default_model: 'gpt-5', default_auto: true });
    expect((list.data as Json[]).filter((m) => m.default).map((m) => m.id)).toEqual(['gpt-5']);
    // No price on the table: shown with an unknown price, never hidden.
    expect((list.data as Json[]).find((m) => m.id === 'gpt-5')).toMatchObject({ price: null, price_source: null });
    expect((list.data as Json[]).find((m) => m.id === 'gpt-image-1')!.capabilities.image_generation).toBe(true);
  });

  it('members read the same list (the agents / assistant / AI column pickers)', async () => {
    const res = await as(member).get(`/ai/connections/${conn}/models`);
    expect(res.status).toBe(200);
    expect(ids(await body(res))).toEqual(['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-image-1']);
  });

  it('a call with no model uses the list default; a default chosen from the list wins', async () => {
    await completeWith(t.deps, acmeId, conn, 'assistant', { messages: say });
    expect(sent.at(-1)!.body).toMatchObject({ model: 'gpt-5' });
    expect((await as(admin).patch(`/ai/connections/${conn}`, { default_model: 'gpt-4o' })).status).toBe(200);
    const list = await models(conn);
    expect(list).toMatchObject({ default_model: 'gpt-4o', default_auto: false });
    expect((list.data as Json[]).find((m) => m.default)!.id).toBe('gpt-4o');
    await completeWith(t.deps, acmeId, conn, 'column', { messages: say });
    expect(sent.at(-1)!.body).toMatchObject({ model: 'gpt-4o' });
    // A Claude id is not an OpenAI model.
    expect((await as(admin).patch(`/ai/connections/${conn}`, { default_model: 'claude-opus-5-5' })).status).toBe(422);
    expect((await as(admin).patch(`/ai/connections/${conn}`, { default_model: null })).status).toBe(200);
  });

  it('agents take a model from the list; starter agents start with the list default', async () => {
    expect((await as(admin).post('/agents', { name: 'GPT', connection_id: conn, model: 'gpt-5-mini' })).status).toBe(
      201,
    );
    expect((await as(admin).post('/agents', { name: 'X', connection_id: conn, model: 'claude-opus-5-5' })).status).toBe(
      422,
    );
    const templates = await body(await as(admin).get('/agents/templates'));
    const seeded = await body(
      await as(admin).post('/agents/templates/seed', { connection_id: conn, keys: [templates.data[0].key] }),
    );
    expect(seeded.data[0].model).toBe('gpt-5');
  });

  it('refresh: a new model appears at once (and becomes the automatic default); a failing provider keeps its list', async () => {
    openaiModels.push({ id: 'gpt-6', created: day('2026-09-01T00:00:00Z') });
    // Cached for the hour: not yet.
    expect(ids(await models(conn))).not.toContain('gpt-6');
    // Only an admin asks the provider again; a member gets the cached list.
    expect(ids(await body(await as(member).get(`/ai/connections/${conn}/models?refresh=true`)))).not.toContain('gpt-6');
    const fresh = await models(conn, true);
    expect(fresh.source).toBe('live');
    expect(ids(fresh)[0]).toBe('gpt-6');
    expect(fresh.default_model).toBe('gpt-6');
    expect(ids(await body(await as(member).get(`/ai/connections/${conn}/models`)))[0]).toBe('gpt-6');
    openaiDown = true;
    const kept = await models(conn, true);
    expect(kept.source).toBe('fallback');
    expect(ids(kept)).toEqual(['gpt-6', 'gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-image-1']);
    openaiDown = false;
  });
});

describe('Gemini: the live list drives the pickers and the default', () => {
  let conn = '';
  it('ranked by the version in the name (Gemini gives no dates); the default is the newest stable tool model', async () => {
    const res = await as(admin).post('/ai/connections', {
      name: 'Gemini',
      provider: 'gemini',
      api_key: 'AIza-test-0000000000',
    });
    expect(res.status).toBe(201);
    conn = (await body(res)).id;
    const list = await models(conn);
    expect(list.source).toBe('live');
    expect(ids(list)).toEqual([
      'gemini-3-pro-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-1.5-flash',
      'gemma-3-27b-it',
      'imagen-4.0-generate-001',
    ]);
    expect(list).toMatchObject({ default_model: 'gemini-2.5-pro', default_auto: true });
    const pro = (list.data as Json[]).find((m) => m.id === 'gemini-2.5-pro')!;
    expect(pro).toMatchObject({ display_name: 'Gemini 2.5 Pro', price: null });
    expect(pro.capabilities.max_context).toBe(1_048_576);
    expect((list.data as Json[]).find((m) => m.id === 'gemma-3-27b-it')!.capabilities.tools).toBe(false);
  });

  it('the assistant / AI columns with no model call the list default; agents take a list model', async () => {
    expect(
      (await as(admin).patch('/ai/settings', { assistant: { enabled: true, connection_id: conn, model: null } }))
        .status,
    ).toBe(200);
    const out = await completeWith(t.deps, acmeId, conn, 'assistant', { messages: say });
    expect(out.text).toBe('gemini answer');
    expect(sent.at(-1)!.url).toBe(`${GEMINI}/models/gemini-2.5-pro:generateContent`);
    expect(
      (await as(admin).post('/agents', { name: 'Gem', connection_id: conn, model: 'gemini-3-pro-preview' })).status,
    ).toBe(201);
    // Gemma calls no tools: refused for an agent.
    expect((await as(admin).post('/agents', { name: 'G2', connection_id: conn, model: 'gemma-3-27b-it' })).status).toBe(
      422,
    );
  });
});

describe('An OpenAI-compatible server: the live list drives the pickers and the default', () => {
  let conn = '';
  it('its list (with what it says of each model) and hand-added models, ranked; default from the list', async () => {
    const res = await as(admin).post('/ai/connections', {
      name: 'OpenRouter-like',
      provider: 'openai_compatible',
      api_key: 'or-test-0000000000',
      base_url: COMPAT,
      manual_models: [{ id: 'my/custom' }],
    });
    expect(res.status).toBe(201);
    conn = (await body(res)).id;
    const list = await models(conn);
    expect(list.source).toBe('live');
    expect(ids(list)).toEqual(['mistral/mistral-large-2411', 'meta/llama-3.1-8b', 'my/custom', 'acme/no-tools']);
    expect(list).toMatchObject({ default_model: 'mistral/mistral-large-2411', default_auto: true });
    expect((list.data as Json[])[0]).toMatchObject({
      display_name: 'Mistral Large',
      price: null,
      capabilities: { tools: true, max_context: 128_000 },
    });
    expect((list.data as Json[]).find((m) => m.id === 'my/custom')!.manual).toBe(true);
    await completeWith(t.deps, acmeId, conn, 'column', { messages: say });
    expect(sent.at(-1)).toMatchObject({
      url: `${COMPAT}/chat/completions`,
      body: { model: 'mistral/mistral-large-2411' },
    });
  });
});

describe('a new connection: the live list before saving', () => {
  it('admins read a provider list with a typed key — nothing is saved', async () => {
    const before = (await body(await as(admin).get('/ai/connections'))).data.length;
    const res = await as(admin).post('/ai/connections/models', {
      provider: 'openai',
      api_key: 'sk-openai-test-000000',
      manual_models: [{ id: 'gpt-hand' }],
    });
    expect(res.status).toBe(200);
    const list = await body(res);
    expect(list.source).toBe('live');
    expect(ids(list)).toContain('gpt-6');
    expect(ids(list)).toContain('gpt-hand');
    expect(list).toMatchObject({ default_model: 'gpt-6', default_auto: true });
    expect((await body(await as(admin).get('/ai/connections'))).data.length).toBe(before);
    const compat = await body(
      await as(admin).post('/ai/connections/models', {
        provider: 'openai_compatible',
        api_key: '',
        base_url: COMPAT,
      }),
    );
    expect(ids(compat)[0]).toBe('mistral/mistral-large-2411');
  });

  it('is guarded: admins only, a key and a public address are required', async () => {
    expect(
      (await as(member).post('/ai/connections/models', { provider: 'openai', api_key: 'sk-openai-test-000000' }))
        .status,
    ).toBe(403);
    const noKey = await as(admin).post('/ai/connections/models', { provider: 'gemini', api_key: '' });
    expect(noKey.status).toBe(422);
    expect((await body(noKey)).error.message).toBe('ai_key_required');
    const local = await as(admin).post('/ai/connections/models', {
      provider: 'openai_compatible',
      base_url: 'http://127.0.0.1:11434/v1',
    });
    expect(local.status).toBe(422);
    expect((await body(local)).error.message).toBe('ai_base_url_private');
  });
});
