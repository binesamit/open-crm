// SPDX-License-Identifier: AGPL-3.0-only
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { and, asc, eq } from 'drizzle-orm';
import { aiTool, needsApproval } from '@bines/shared';
import {
  type AiClientFactory,
  createAiClient,
  type FetchLike,
  scriptedAnthropic,
  TINY_PNG_BASE64,
} from '@bines/server-ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog, aiUsage, automationRuns } from '../src/db/schema';
import { generateImages } from '../src/modules/ai/images.service';
import { clearModelCache } from '../src/modules/ai/models.service';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * AI images against a mocked OpenAI (no network, no money): the account's image settings,
 * the `generate_image` tool over MCP (into a file column, onto a new update), capability and provider refusals,
 * a provider's safety refusal as a readable error, the cost from the price table (tokens, then per image), the
 * approval rule, the automation action, AI columns with image output and the plan's `ai` gate.
 */
let t: TestContext;
let owner: string;
let admin: string;
let acmeId: string;
let boardId: string;
let fileKey: string;
let openai: string;
let anthropic: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const prompts: string[] = [];
const providerFetch: FetchLike = async (url, init) => {
  const reply = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (url === 'https://api.openai.com/v1/models')
    return reply({ data: [{ id: 'gpt-5' }, { id: 'gpt-image-1' }, { id: 'dall-e-3' }] });
  if (url === 'https://api.openai.com/v1/images/generations') {
    const req = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Json;
    prompts.push(req.prompt as string);
    if (String(req.prompt).includes('BLOCKED'))
      return reply(
        { error: { message: 'Your request was rejected by the safety system.', code: 'moderation_blocked' } },
        400,
      );
    return reply({
      data: Array.from({ length: Number(req.n ?? 1) }, () => ({ b64_json: TINY_PNG_BASE64 })),
      usage: { input_tokens: 50, output_tokens: 4160 },
    });
  }
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
const as = (cookie = admin) => t.api(cookie, acmeId);
const newItem = async (name: string) =>
  (await body(await as().post(`/boards/${boardId}/items`, { name }))).id as string;
const filesOf = async (itemId: string, key = fileKey) =>
  ((await body(await as().get(`/items/${itemId}`))).cells[key]?.value?.files ?? []) as Json[];
const setImages = async (images: Json) => {
  const res = await as().patch('/ai/settings', { images });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
};

// MCP: an SDK client on the in-process app.
const fetchApp = (url: string | URL | Request, init?: RequestInit) =>
  t.app.request(url instanceof Request ? url : String(url), init) as Promise<Response>;
let client: Client;
const connect = async () => {
  const token = (await body(await as().post('/auth/tokens', { name: 'Claude Code', scopes: ['admin'] })))
    .token as string;
  const c = new Client({ name: 'images', version: '1.0.0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${WEB_ORIGIN}/mcp`), {
      fetch: fetchApp,
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return c;
};
const call = async (name: string, args: Json) => {
  const res = (await client.callTool({ name, arguments: args })) as Json;
  const parsed = JSON.parse(res.content?.[0]?.text ?? '{}') as Json;
  return { isError: !!res.isError, data: parsed, error: parsed.error as Json | undefined };
};

const seen = new Set<string>();
const drain = async () => {
  const rows = await t.db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(eq(activityLog.accountId, acmeId))
    .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);
  }
};

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
  expect((await as().patch('/ai/settings', { enabled: true })).status).toBe(200);
  const wsId = (await body(await as().get('/workspaces'))).data[0].id as string;
  boardId = (await body(await as().post('/boards', { name: 'Designs', workspace_id: wsId }))).id as string;
  fileKey = (await body(await as().post(`/boards/${boardId}/columns`, { title: 'Images', type: 'file' }))).id;
  openai = (
    await body(
      await as().post('/ai/connections', {
        name: 'OpenAI',
        provider: 'openai',
        api_key: 'sk-openai-test-000000',
        default_model: 'gpt-5',
      }),
    )
  ).id as string;
  anthropic = (
    await body(
      await as().post('/ai/connections', {
        name: 'Claude',
        provider: 'anthropic',
        api_key: 'sk-ant-test-000000000',
        // An admin wrongly marks a Claude model as making images: the provider still cannot.
        manual_models: [{ id: 'claude-haiku-4-5', capabilities: { image_generation: true } }],
      }),
    )
  ).id as string;
  client = await connect();
});
afterAll(async () => {
  await client?.close();
  await t.close();
});

describe('settings and models', () => {
  it('the account settings carry image defaults; image models are listed with the capability', async () => {
    const s = await body(await as().get('/ai/settings'));
    expect(s.images).toEqual({
      connection_id: null,
      model: null,
      size: '1024x1024',
      quality: 'auto',
      max_images: 1,
      // AI image runs side by side (1 = one image at a time).
      concurrency: 1,
    });
    expect((await as().patch('/ai/settings', { images: { concurrency: 5 } })).status).toBe(400);
    const models = (await body(await as().get(`/ai/connections/${openai}/models`))).data as Json[];
    const caps = Object.fromEntries(models.map((m) => [m.id, m.capabilities.image_generation]));
    expect(caps).toMatchObject({ 'gpt-image-1': true, 'dall-e-3': true, 'gpt-5': false });
    expect((await as().patch('/ai/settings', { images: { size: '12' } })).status).toBe(400);
  });

  it('the owner price table: per-image prices (and by size / quality), seeded for OpenAI image models', async () => {
    const rows = (await body(await t.api(owner).get('/platform/ai-prices'))).data as Json[];
    expect(rows.find((r) => r.model === 'gpt-image-1')).toMatchObject({ input: 5, output: 40, per_image: null });
    const dalle = rows.find((r) => r.model === 'dall-e-3')!;
    expect(dalle).toMatchObject({ per_image: 0.04, image_prices: { '1024x1024/hd': 0.08 } });
    const bad = await t.api(owner).patch(`/platform/ai-prices/${dalle.id}`, { image_prices: { 'not a key!': 1 } });
    expect(bad.status).toBe(400);
  });
});

describe('the generate_image tool (MCP)', () => {
  it('is listed for MCP, sensitive and open-world: an agent always waits for a person', async () => {
    const tools = (await client.listTools()).tools.map((x) => x.name);
    expect(tools).toContain('generate_image');
    const def = aiTool('generate_image')!;
    expect(def).toMatchObject({ risk: 'sensitive', scope: 'items:write' });
    expect(needsApproval(def, { approval_mode: 'autonomous', approval_tools: [] })).toBe(true);
  });

  it('refuses until an image connection is chosen', async () => {
    const r = await call('generate_image', { item_id: await newItem('Logo'), prompt: 'a logo', column_id: fileKey });
    expect(r.isError).toBe(true);
    expect(r.error?.message).toBe('ai_images_not_configured');
  });

  it('refuses a model that does not make images, and a provider that cannot', async () => {
    const itemId = await newItem('Banner');
    await setImages({ connection_id: openai, model: 'gpt-5' });
    let r = await call('generate_image', { item_id: itemId, prompt: 'a banner', column_id: fileKey });
    expect(r.error).toMatchObject({ code: 'invalid_value', message: 'ai_model_no_image_generation' });
    await setImages({ connection_id: anthropic, model: 'claude-haiku-4-5' });
    r = await call('generate_image', { item_id: itemId, prompt: 'a banner', column_id: fileKey });
    expect(r.error).toMatchObject({ message: 'ai_provider_no_image_generation' });
    expect(prompts).toEqual([]);
  });

  it('makes the image into a file column, costed by tokens from the price table', async () => {
    await setImages({ connection_id: openai, model: 'gpt-image-1', size: '1024x1024', quality: 'high' });
    const itemId = await newItem('Poster');
    const r = await call('generate_image', {
      item_id: itemId,
      prompt: 'A poster of a red fox',
      column_id: fileKey,
      file_name: 'fox poster',
    });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.files).toHaveLength(1);
    expect(r.data.files[0]).toMatchObject({ name: 'fox-poster.png', mime: 'image/png' });
    // gpt-image-1 bills tokens: 50 in × $5 + 4160 out × $40 per 1M.
    expect(r.data.cost_usd).toBeCloseTo((50 * 5 + 4160 * 40) / 1_000_000, 9);
    const files = await filesOf(itemId);
    expect(files.map((f) => f.asset_id)).toEqual([r.data.files[0].id]);
    expect([...t.storage.objects.values()].some((o) => o.mime === 'image/png')).toBe(true);
    const usage = await t.db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.accountId, acmeId), eq(aiUsage.source, 'image')));
    expect(usage[0]).toMatchObject({ model: 'gpt-image-1', calls: 1, outputTokens: 4160 });
    const report = await body(await as().get('/ai/usage'));
    expect((report.rows as Json[]).find((x) => x.source === 'image')).toMatchObject({ price_known: true });
  });

  it('without a column: a new update carries the images (capped by the account setting)', async () => {
    await setImages({ connection_id: openai, model: 'gpt-image-1', max_images: 2 });
    const itemId = await newItem('Moodboard');
    const r = await call('generate_image', { item_id: itemId, prompt: 'Calm blue tones', count: 4 });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.files).toHaveLength(2);
    expect(r.data.update_id).toBeTruthy();
    const updates = (await body(await as().get(`/items/${itemId}/updates`))).data as Json[];
    expect(updates[0]!.files.map((f: Json) => f.id).sort()).toEqual(r.data.files.map((f: Json) => f.id).sort());
    expect(updates[0]!.body_text).toContain('Calm blue tones');
  });

  it('a per-image price wins over tokens once the owner sets one', async () => {
    const row = ((await body(await t.api(owner).get('/platform/ai-prices'))).data as Json[]).find(
      (x) => x.model === 'gpt-image-1',
    )!;
    const res = await t.api(owner).patch(`/platform/ai-prices/${row.id}`, {
      per_image: 0.05,
      image_prices: { '1024x1024/high': 0.17 },
    });
    expect(res.status).toBe(200);
    await setImages({ connection_id: openai, model: 'gpt-image-1', size: '1024x1024', quality: 'high' });
    const r = await call('generate_image', { item_id: await newItem('Card'), prompt: 'x', column_id: fileKey });
    expect(r.data.cost_usd).toBe(0.17);
    const low = await call('generate_image', {
      item_id: await newItem('Card 2'),
      prompt: 'x',
      column_id: fileKey,
      quality: 'low',
    });
    expect(low.data.cost_usd).toBe(0.05);
  });

  it("a provider's safety refusal is a readable error with its reason; nothing is saved", async () => {
    const itemId = await newItem('Refused');
    const r = await call('generate_image', { item_id: itemId, prompt: 'BLOCKED thing', column_id: fileKey });
    expect(r.error).toMatchObject({
      code: 'unprocessable',
      message: 'ai_image_content_policy',
      details: { provider_message: 'Your request was rejected by the safety system.' },
    });
    expect(await filesOf(itemId)).toEqual([]);
  });

  it('accounts that block sensitive AI tools do not get it', async () => {
    await as().patch('/ai/settings', { mcp_sensitive: 'block' });
    const c = await connect();
    expect((await c.listTools()).tools.map((x) => x.name)).not.toContain('generate_image');
    await c.close();
    await as().patch('/ai/settings', { mcp_sensitive: 'allow' });
  });
});

describe('the automation action', () => {
  it('validates the file column, renders the prompt template and saves the image as the owner', async () => {
    const wrong = await as().post(`/boards/${boardId}/automations`, {
      recipe: {
        trigger: { type: 'item_created' },
        actions: [{ type: 'generate_image', column: 'name', prompt: 'x' }],
      },
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const res = await as().post(`/boards/${boardId}/automations`, {
      recipe: {
        trigger: { type: 'item_created' },
        actions: [{ type: 'generate_image', column: fileKey, prompt: 'A logo for {item.name}' }],
      },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const automationId = (await body(res)).id as string;
    await drain();
    const itemId = await newItem('Bakery');
    await drain();
    expect(prompts.at(-1)).toBe('A logo for Bakery');
    expect(await filesOf(itemId)).toHaveLength(1);
    const runs = await t.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automationId))
      .orderBy(asc(automationRuns.createdAt));
    expect((runs.at(-1)!.actionsLog as Json[])[0]).toMatchObject({ type: 'generate_image', status: 'ok' });
    await as().patch(`/automations/${automationId}`, { is_active: false });
  });
});

describe('AI columns with image output', () => {
  it('needs a file column; the image lands there and the AI cell keeps its name', async () => {
    const res = await as().post(`/boards/${boardId}/columns`, {
      title: 'AI poster',
      type: 'ai',
      settings: { connection_id: openai, model: 'gpt-image-1', output: 'image', instructions: 'Poster of {Name}' },
    });
    expect(res.status).toBe(201);
    const col = (await body(res)).id as string;
    const info = await body(await as().get(`/boards/${boardId}/ai-columns/${col}`));
    expect(info).toMatchObject({ ready: false, reason: 'no_image_column' });
    await as().patch(`/boards/${boardId}/columns/${col}`, {
      settings: {
        connection_id: openai,
        model: 'gpt-image-1',
        output: 'image',
        instructions: 'Poster of {Name}',
        image_column: fileKey,
      },
    });
    const itemId = await newItem('Jazz night');
    const run = await body(
      await as().post(`/boards/${boardId}/ai-columns/${col}/run`, { mode: 'items', item_ids: [itemId] }),
    );
    expect(run, JSON.stringify(run)).toMatchObject({ done: 1, failed: 0 });
    expect(prompts.at(-1)).toBe('Poster of Jazz night');
    const files = await filesOf(itemId);
    expect(files).toHaveLength(1);
    const cell = (await body(await as().get(`/items/${itemId}`))).cells[col].value as Json;
    expect(cell).toMatchObject({ text: files[0]!.name, file_id: files[0]!.asset_id, ai: { output: 'image' } });
  });
});

describe("the plan's ai feature", () => {
  it('a plan without AI refuses images and saving the automation action', async () => {
    const plan = await body(
      await t.api(owner).post('/platform/plans', { name: 'No AI', version: { features: ['guests', 'api'] } }),
    );
    const assign = await t
      .api(owner)
      .put(`/platform/accounts/${acmeId}/subscription`, { plan_version_id: plan.versions[0].id });
    expect(assign.status).toBe(200);
    await expect(generateImages(t.deps, acmeId, { prompt: 'x' })).rejects.toMatchObject({
      code: 'plan_feature_unavailable',
      details: { feature: 'ai', upgrade: true },
    });
    const res = await as().post(`/boards/${boardId}/automations`, {
      recipe: {
        trigger: { type: 'item_created' },
        actions: [{ type: 'generate_image', column: fileKey, prompt: 'x' }],
      },
    });
    expect(res.status).toBe(402);
    expect((await body(res)).error.details).toEqual({ feature: 'ai', upgrade: true });
  });
});
