// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { type AiClientFactory, type AnthropicLike, createAiClient } from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountMembers, aiUsage, users } from '../src/db/schema';
import { completeWith } from '../src/modules/ai/ai.service';
import { clearModelCache, MODELS_TTL_MS, connectionModels } from '../src/modules/ai/models.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Fix: (shell): per-account profile fields (job title, department, phone on the membership), favourites of
 * every type (boards, docs, dashboards in one order), and AI models read live from the provider (a mocked
 * Anthropic client — no test spends money), cached an hour per connection, with the catalogue as the fallback.
 */
let t: TestContext;
let admin: string;
let bob: string;
let vera: string;
let otherAdmin: string;
let acmeId: string;
let otherId: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

// ---- the mocked provider ----
let listCalls = 0;
let listFails = false;
const LIVE = [
  {
    type: 'model',
    id: 'claude-sonnet-5-5',
    display_name: 'Claude Sonnet 5.5',
    created_at: '2026-08-01T00:00:00Z',
    capabilities: null,
  },
  {
    type: 'model',
    id: 'claude-nova-6',
    display_name: 'Claude Nova 6',
    created_at: '2026-10-01T00:00:00Z',
    capabilities: {
      thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
      effort: { supported: true },
    },
  },
  {
    type: 'model',
    id: 'claude-opus-5-5',
    display_name: 'Claude Opus 5.5',
    created_at: '2026-09-01T00:00:00Z',
    capabilities: null,
  },
];
const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
const fakeAnthropic: AnthropicLike = {
  messages: {
    create: async (params) => {
      sent.push(params);
      return {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: params.model,
        content: [{ type: 'text', text: 'ok', citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      } as unknown as Anthropic.Message;
    },
  },
  models: {
    list: async () => {
      listCalls += 1;
      if (listFails) throw new Error('offline');
      return { data: LIVE, has_more: false, last_id: 'claude-opus-5-5' };
    },
  },
};
const aiClient: AiClientFactory = (conn) => createAiClient(conn, { anthropic: fakeAnthropic });

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string, account = acmeId) => t.api(cookie, account);

beforeAll(async () => {
  t = await createTestContext({ aiClient });
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'admin@other.test');
  admin = await join('admin@acme.test');
  otherAdmin = await join('admin@other.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  await as(admin).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  vera = await join('vera@acme.test');
  // Bob is also a member of "Other" — where he is someone else.
  await as(otherAdmin, otherId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  expect((await t.api(bob).post('/invitations/accept', { token: t.inviteTokenFor('bob@acme.test') })).status).toBe(200);
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

const bobId = async () => (await t.db.select().from(users).where(eq(users.email, 'bob@acme.test')))[0]!.id;

describe('profile fields per account', () => {
  it('job title, department and phone are mine in each account; name and birthday everywhere', async () => {
    const res = await as(bob).patch('/users/me', {
      name: 'Bob Builder',
      title: 'מנהל',
      department: 'מכירות',
      phone: '+972 50 000 0000',
      birthday: '1990-05-17',
    });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      name: 'Bob Builder',
      title: 'מנהל',
      department: 'מכירות',
      account: { id: acmeId, name: 'Acme' },
    });
    // In "Other": the same person, none of Acme's job details.
    const other = await body(await as(bob, otherId).get('/users/me'));
    expect(other).toMatchObject({ name: 'Bob Builder', birthday: '1990-05-17', title: null, department: null });
    await as(bob, otherId).patch('/users/me', { title: 'יועץ' });
    expect((await body(await as(bob).get('/users/me'))).title).toBe('מנהל');
    expect((await body(await as(bob, otherId).get('/users/me'))).title).toBe('יועץ');
    // Each account's people list shows that account's title.
    const acmeList = (await body(await as(admin).get('/users'))).data as Json[];
    expect(acmeList.find((m) => m.email === 'bob@acme.test')).toMatchObject({ title: 'מנהל', department: 'מכירות' });
    const otherList = (await body(await as(otherAdmin, otherId).get('/users'))).data as Json[];
    expect(otherList.find((m) => m.email === 'bob@acme.test')).toMatchObject({ title: 'יועץ', department: null });
  });

  it("an account's admin edits them in that account only; a member edits no one else's", async () => {
    const id = await bobId();
    expect((await as(otherAdmin, otherId).patch(`/users/${id}`, { department: 'ייעוץ' })).status).toBe(200);
    expect((await body(await as(bob, otherId).get('/users/me'))).department).toBe('ייעוץ');
    expect((await body(await as(bob).get('/users/me'))).department).toBe('מכירות');
    // An admin of Acme cannot reach Bob's "Other" membership: the request is always in its own account.
    await as(admin).patch(`/users/${id}`, { title: 'סמנכ"ל' });
    expect((await body(await as(bob, otherId).get('/users/me'))).title).toBe('יועץ');
    // A member (Bob) may not edit someone else.
    const adminId = (await t.db.select().from(users).where(eq(users.email, 'admin@acme.test')))[0]!.id;
    expect((await as(bob).patch(`/users/${adminId}`, { title: 'x' })).status).toBe(403);
  });

  it('the migration moves the old per-user values into every membership', async () => {
    const id = await bobId();
    await t.db.update(users).set({ title: 'ישן', department: 'ישנה', phone: '050' }).where(eq(users.id, id));
    await t.db
      .update(accountMembers)
      .set({ title: null, department: null, phone: null })
      .where(eq(accountMembers.userId, id));
    const file = joinPath(fileURLToPath(new URL('.', import.meta.url)), '../drizzle/0039_r10shell.sql');
    const update = readFileSync(file, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .find((s) => s.includes('UPDATE "account_members"'))!;
    await t.db.execute(sql.raw(update));
    const rows = await t.db.select().from(accountMembers).where(eq(accountMembers.userId, id));
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ title: 'ישן', department: 'ישנה', phone: '050' });
  });
});

describe('favourites of every type', () => {
  let board: string;
  let doc: string;
  let dash: string;
  let hidden: string;

  beforeAll(async () => {
    board = (await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
    doc = (await body(await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Spec' }))).id;
    dash = (await body(await as(admin).post(`/workspaces/${wsId}/dashboards`, { name: 'KPIs' }))).id;
    hidden = (await body(await as(admin).post('/boards', { name: 'Secret', workspace_id: wsId, kind: 'private' }))).id;
  });

  it('boards, docs and dashboards in one list, in my order, with their types', async () => {
    const put = await as(admin).put('/me/favorites', {
      items: [
        { type: 'dashboard', id: dash },
        { type: 'board', id: board },
        { type: 'doc', id: doc },
        { type: 'board', id: board },
      ],
    });
    expect(put.status).toBe(200);
    const list = (await body(await as(admin).get('/me/favorites'))).data as Json[];
    expect(list.map((f) => [f.type, f.name])).toEqual([
      ['dashboard', 'KPIs'],
      ['board', 'Leads'],
      ['doc', 'Spec'],
    ]);
    // Reordered.
    await as(admin).put('/me/favorites', {
      items: [
        { type: 'doc', id: doc },
        { type: 'dashboard', id: dash },
        { type: 'board', id: board },
      ],
    });
    expect(((await body(await as(admin).get('/me/favorites'))).data as Json[]).map((f) => f.type)).toEqual([
      'doc',
      'dashboard',
      'board',
    ]);
  });

  it('the older per-type endpoints read and write the same list', async () => {
    expect((await body(await as(admin).get('/me/favorite-boards'))).data).toEqual([
      { id: board, name: 'Leads', workspace_id: wsId },
    ]);
    expect(((await body(await as(admin).get('/me/favorite-docs'))).data as Json[]).map((d) => d.id)).toEqual([doc]);
    // Un-star the doc on its page (the docs endpoint): it leaves the combined list, the others keep their order.
    await as(admin).put('/me/favorite-docs', { doc_ids: [] });
    expect(((await body(await as(admin).get('/me/favorites'))).data as Json[]).map((f) => f.type)).toEqual([
      'dashboard',
      'board',
    ]);
    // Star it again there: it is back (in the place it had).
    await as(admin).put('/me/favorite-docs', { doc_ids: [doc] });
    expect(((await body(await as(admin).get('/me/favorites'))).data as Json[]).map((f) => f.type)).toEqual([
      'doc',
      'dashboard',
      'board',
    ]);
    // Boards through the older endpoint keep the dashboard and the doc in place.
    await as(admin).put('/me/favorite-boards', { board_ids: [] });
    expect(((await body(await as(admin).get('/me/favorites'))).data as Json[]).map((f) => f.type)).toEqual([
      'doc',
      'dashboard',
    ]);
  });

  it('what I cannot open is dropped; favourites are per person and per account', async () => {
    const res = await body(
      await as(bob).put('/me/favorites', {
        items: [
          { type: 'board', id: hidden },
          { type: 'board', id: board },
          { type: 'dashboard', id: dash },
          { type: 'doc', id: 'NOPE' },
        ],
      }),
    );
    expect((res.data as Json[]).map((f) => f.id)).toEqual([board, dash]);
    expect(((await body(await as(admin).get('/me/favorites'))).data as Json[]).some((f) => f.id === board)).toBe(false);
    expect((await body(await as(bob, otherId).get('/me/favorites'))).data).toEqual([]);
    // A deleted dashboard leaves the list.
    await as(admin).del(`/dashboards/${dash}`);
    expect(((await body(await as(bob).get('/me/favorites'))).data as Json[]).map((f) => f.id)).toEqual([board]);
  });
});

describe('AI models from the provider', () => {
  let conn: string;

  beforeAll(async () => {
    await as(admin).patch('/ai/settings', { enabled: true });
  });
  beforeEach(() => {
    listFails = false;
  });

  it('a new connection is checked against the live list (newest first, display names)', async () => {
    clearModelCache();
    // A model only the live list has is a valid default; one nobody has is refused.
    const bad = await as(admin).post('/ai/connections', {
      name: 'x',
      api_key: 'sk-ant-1234567890',
      default_model: 'gpt-9',
    });
    expect(bad.status).toBe(422);
    const res = await as(admin).post('/ai/connections', {
      name: 'Claude',
      api_key: 'sk-ant-1234567890',
      default_model: 'claude-nova-6',
    });
    expect(res.status).toBe(201);
    conn = (await body(res)).id;
    const before = listCalls;
    const list = await body(await as(admin).get(`/ai/connections/${conn}/models`));
    // Seeded by the save: no second call to the provider.
    expect(listCalls).toBe(before);
    expect(list.source).toBe('live');
    expect((list.data as Json[]).map((m) => m.id)).toEqual(['claude-nova-6', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(list.data[0]).toMatchObject({
      display_name: 'Claude Nova 6',
      price: null,
      price_source: null,
      default: true,
    });
    // The platform's price table (seeded by migration with the prices that used to be in code).
    expect(list.data[1]).toMatchObject({ price: { input: 4, output: 20 }, price_source: 'table' });
  });

  it('is cached an hour per connection; refresh asks again (admins); a new key reads again', async () => {
    const n = listCalls;
    await as(admin).get(`/ai/connections/${conn}/models`);
    await as(bob).get(`/ai/connections/${conn}/models`);
    expect(listCalls).toBe(n);
    await as(admin).get(`/ai/connections/${conn}/models?refresh=true`);
    expect(listCalls).toBe(n + 1);
    // A member's refresh uses the cache.
    await as(bob).get(`/ai/connections/${conn}/models?refresh=true`);
    expect(listCalls).toBe(n + 1);
    await as(admin).patch(`/ai/connections/${conn}`, { api_key: 'sk-ant-new-key-0000' });
    await as(admin).get(`/ai/connections/${conn}/models`);
    expect(listCalls).toBe(n + 2);
    // Past the hour: asked again.
    const row = (await t.db.execute(sql`select id, provider, key_enc from ai_connections where id = ${conn}`))
      .rows[0] as { id: string; provider: string; key_enc: string };
    await connectionModels(
      t.deps,
      { id: row.id, provider: row.provider, keyEnc: row.key_enc },
      {
        now: Date.now() + MODELS_TTL_MS + 1000,
      },
    );
    expect(listCalls).toBe(n + 3);
  });

  it('viewers and guests get no model list; another account gets 404', async () => {
    expect((await as(vera).get(`/ai/connections/${conn}/models`)).status).toBe(403);
    expect((await as(otherAdmin, otherId).get(`/ai/connections/${conn}/models`)).status).toBe(404);
  });

  it('keeps the last live list when the provider cannot be read (new models do not vanish)', async () => {
    listFails = true;
    const list = await body(await as(admin).get(`/ai/connections/${conn}/models?refresh=true`));
    expect(list.source).toBe('fallback');
    expect((list.data as Json[]).map((m) => m.id)).toContain('claude-nova-6');
    // A connection never read live: the static catalogue stands in.
    clearModelCache();
    const cold = await body(await as(admin).get(`/ai/connections/${conn}/models?refresh=true`));
    expect(cold.source).toBe('fallback');
    expect((cold.data as Json[]).map((m) => m.id)).toContain('claude-opus-5-5');
    expect((cold.data as Json[]).map((m) => m.id)).not.toContain('claude-nova-6');
    listFails = false;
    expect((await body(await as(admin).get(`/ai/connections/${conn}/models?refresh=true`))).source).toBe('live');
  });

  it('an unknown price costs 0 until an admin sets one; then calls are priced with it', async () => {
    await completeWith(t.deps, acmeId, conn, 'test', {
      model: 'claude-nova-6',
      messages: [{ role: 'user', content: 'x' }],
      agentic: true,
    });
    // What a live-only model takes comes from its capabilities.
    expect(sent.at(-1)).toMatchObject({ model: 'claude-nova-6', thinking: { type: 'adaptive' } });
    const zero = await t.db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.accountId, acmeId), eq(aiUsage.model, 'claude-nova-6')));
    expect(zero[0]!.costUsd).toBe(0);
    expect((await as(bob).patch(`/ai/connections/${conn}`, { price_overrides: {} })).status).toBe(403);
    const patched = await body(
      await as(admin).patch(`/ai/connections/${conn}`, {
        price_overrides: { 'claude-nova-6': { input: 3, output: 15 } },
      }),
    );
    expect(patched.price_overrides).toEqual({ 'claude-nova-6': { input: 3, output: 15 } });
    const list = await body(await as(admin).get(`/ai/connections/${conn}/models`));
    expect((list.data as Json[]).find((m) => m.id === 'claude-nova-6')).toMatchObject({
      price: { input: 3, output: 15 },
      price_source: 'override',
    });
    const out = await completeWith(t.deps, acmeId, conn, 'test', {
      model: 'claude-nova-6',
      messages: [{ role: 'user', content: 'x' }],
    });
    // 1M in × $3 + 1M out × $15.
    expect(out.costUsd).toBe(18);
    // Removing the override: back to unknown.
    await as(admin).patch(`/ai/connections/${conn}`, { price_overrides: { 'claude-nova-6': null } });
    expect(
      ((await body(await as(admin).get(`/ai/connections/${conn}/models`))).data as Json[]).find(
        (m) => m.id === 'claude-nova-6',
      )!.price,
    ).toBeNull();
  });

  it('agents may use a model only the live list has; a model nobody lists is refused', async () => {
    const ok = await as(admin).post('/agents', {
      name: 'Nova agent',
      connection_id: conn,
      model: 'claude-nova-6',
      instructions: 'x',
    });
    expect(ok.status).toBe(201);
    const bad = await as(admin).post('/agents', {
      name: 'Bad agent',
      connection_id: conn,
      model: 'claude-imaginary-1',
      instructions: 'x',
    });
    expect(bad.status).toBe(422);
  });
});
