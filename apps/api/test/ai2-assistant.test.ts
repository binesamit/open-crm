// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { and, eq, isNull } from 'drizzle-orm';
import { type AiClientFactory, type AnthropicLike, createAiClient, scriptedAnthropic } from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activityLog, aiUsage, items } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * The AI assistant panel (the planning notes "AGENTS-MCP" מ12) against the scripted model (`TOOL <name> <json>` lines in
 * the person's message play as tool calls; no money is spent): availability, streaming, read tools as the person,
 * write tools only as approved actions (one undoable batch), history and isolation, limits and the budget.
 */
let t: TestContext;
let admin: string;
let bob: string;
let carol: string;
let otherAdmin: string;
let acmeId: string;
let otherId: string;
let leadsId: string;
let privateId: string;
let connectionId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
const scripted = scriptedAnthropic();
const fake: AnthropicLike = {
  ...scripted,
  messages: {
    create: async (params, options) => {
      requests.push(structuredClone(params));
      return scripted.messages.create(params, options);
    },
  },
};
const aiClient: AiClientFactory = (conn) => createAiClient(conn, { anthropic: fake });

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string, accountId = acmeId) => t.api(cookie, accountId);

/** Reads a text/event-stream answer into its events. */
const events = async (res: Response) =>
  (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()) as Json);

const chat = async (ctx: Json = { board_id: leadsId }, cookie = admin) => {
  const res = await as(cookie).post('/ai/assistant/conversations', ctx);
  const json = await body(res);
  expect(res.status, JSON.stringify(json)).toBe(201);
  return json.id as string;
};
const say = async (conv: string, text: string, cookie = admin) => {
  const res = await as(cookie).post(`/ai/assistant/conversations/${conv}/messages`, { text });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const evs = await events(res);
  return { evs, last: evs.at(-1)! };
};
const itemsNamed = (name: string) =>
  t.db
    .select()
    .from(items)
    .where(and(eq(items.boardId, leadsId), eq(items.name, name), isNull(items.deletedAt)));

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
  await as(admin).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  carol = await join('carol@acme.test');
  const a = as(admin);
  connectionId = (
    await body(
      await a.post('/ai/connections', { name: 'Claude', provider: 'anthropic', api_key: 'sk-ant-test-0000000000' }),
    )
  ).id;
  const wsId = (await body(await a.get('/workspaces'))).data[0].id;
  leadsId = (await body(await a.post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  privateId = (await body(await a.post('/boards', { name: 'Admin only', workspace_id: wsId, kind: 'private' }))).id;
  await a.post(`/boards/${leadsId}/items`, { name: 'Dana' });
});
afterAll(() => t.close());
beforeEach(() => {
  requests.length = 0;
});

const assistant = (patch: Json) =>
  as(admin).patch('/ai/settings', {
    assistant: {
      enabled: true,
      connection_id: connectionId,
      model: 'claude-sonnet-5-5',
      roles: ['member', 'viewer'],
      max_steps: 8,
      max_usd_per_message: 0.5,
      daily_messages_per_user: 100,
      ...patch,
    },
  });

describe('assistant — availability', () => {
  it('is off until AI is on and a connection is chosen; then members and viewers may chat', async () => {
    expect(await body(await as(bob).get('/ai/assistant/status'))).toMatchObject({
      available: false,
      reason: 'ai_disabled',
      can_configure: false,
    });
    expect((await body(await as(admin).get('/ai/assistant/status'))).can_configure).toBe(true);
    expect((await as(bob).post('/ai/assistant/conversations', { board_id: leadsId })).status).toBe(403);
    await as(admin).patch('/ai/settings', { enabled: true });
    expect((await body(await as(bob).get('/ai/assistant/status'))).reason).toBe('not_configured');
    expect((await assistant({})).status).toBe(200);
    expect(await body(await as(bob).get('/ai/assistant/status'))).toMatchObject({
      available: true,
      model: 'claude-sonnet-5-5',
    });
    await assistant({ roles: ['viewer'] });
    expect((await body(await as(bob).get('/ai/assistant/status'))).reason).toBe('role');
    await assistant({});
  });

  it('is a session feature (never an API token)', async () => {
    const tok = await body(await as(admin).post('/auth/tokens', { name: 'x', scopes: ['admin'] }));
    const res = await t.app.request('/api/v1/ai/assistant/status', {
      headers: { authorization: `Bearer ${tok.token}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('assistant — a conversation', () => {
  it('streams an answer and uses read tools freely, as the person', async () => {
    const conv = await chat();
    const { evs, last } = await say(conv, `what is late?\nTOOL get_board {"board_id":"${leadsId}"}`);
    expect(evs[0]).toMatchObject({ type: 'user' });
    expect(evs.some((e) => e.type === 'read' && e.tool === 'get_board')).toBe(true);
    expect(evs.some((e) => e.type === 'delta')).toBe(true);
    expect(last).toMatchObject({ type: 'done', message: { role: 'assistant', reads: ['get_board'], actions: [] } });
    expect(last.message.cost_usd).toBeGreaterThan(0);
    // The board context is in the person's turn: ids plain, the name wrapped as data.
    const first = JSON.stringify(requests[0]!.messages.at(-1));
    expect(first).toContain(`board_id: ${leadsId}`);
    expect(first).toContain('<untrusted_content source=\\"context\\">');
    expect(requests[0]!.model).toBe('claude-sonnet-5-5');
    // The tool result went back to the model.
    expect(JSON.stringify(requests[1]!.messages.at(-1))).toContain('Leads');
    const usage = await t.db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.accountId, acmeId), eq(aiUsage.source, 'assistant')));
    expect(usage.length).toBeGreaterThan(0);
  });

  it('write tools only propose actions; approving runs them as one batch that one undo takes back', async () => {
    const conv = await chat();
    const { evs, last } = await say(
      conv,
      `create 2 tasks\nTOOL create_item {"board_id":"${leadsId}","name":"Task A"}\nTOOL create_item {"board_id":"${leadsId}","name":"Task B"}`,
    );
    expect(evs.filter((e) => e.type === 'action')).toHaveLength(2);
    const msg = last.message;
    expect(msg.actions.map((x: Json) => x.status)).toEqual(['pending', 'pending']);
    expect(msg.actions[0].preview).toContain('Task A');
    // Nothing was written yet.
    expect(await itemsNamed('Task A')).toHaveLength(0);
    // Someone else cannot decide them.
    expect(
      (await as(bob).post(`/ai/assistant/messages/${msg.id}/actions`, { approve: [msg.actions[0].id] })).status,
    ).toBe(404);
    const res = await body(
      await as(admin).post(`/ai/assistant/messages/${msg.id}/actions`, { approve: msg.actions.map((x: Json) => x.id) }),
    );
    expect(res.batch_id).toBeTruthy();
    expect(res.message.actions.map((x: Json) => x.status)).toEqual(['done', 'done']);
    expect(await itemsNamed('Task A')).toHaveLength(1);
    expect(await itemsNamed('Task B')).toHaveLength(1);
    const evRows = await t.db.select().from(activityLog).where(eq(activityLog.batchId, res.batch_id));
    expect(evRows.length).toBeGreaterThanOrEqual(2);
    expect(evRows.every((r) => (r.payload as Json).meta?.via === 'ai')).toBe(true);
    // Approving again does nothing.
    const again = await body(
      await as(admin).post(`/ai/assistant/messages/${msg.id}/actions`, { approve: msg.actions.map((x: Json) => x.id) }),
    );
    expect(again.batch_id).toBeNull();
    const undo = await as(admin).post(`/activity/batches/${res.batch_id}/undo`, {});
    expect(undo.status, JSON.stringify(await body(undo.clone()))).toBe(200);
    expect(await itemsNamed('Task A')).toHaveLength(0);
    expect(await itemsNamed('Task B')).toHaveLength(0);
  });

  it('a rejected proposal is reported to the model in the next turn; history replays unchanged', async () => {
    const conv = await chat();
    const { last } = await say(conv, `TOOL create_item {"board_id":"${leadsId}","name":"Nope"}`);
    const id = last.message.actions[0].id;
    const res = await body(await as(admin).post(`/ai/assistant/messages/${last.message.id}/actions`, { reject: [id] }));
    expect(res.message.actions[0].status).toBe('rejected');
    requests.length = 0;
    await say(conv, 'ok, thanks');
    const sent = requests[0]!.messages;
    // The earlier turns are sent back exactly (thinking blocks with their signatures).
    expect(JSON.stringify(sent)).toContain('sig-0');
    expect(JSON.stringify(sent.at(-1))).toContain('rejected by the person');
    expect(await itemsNamed('Nope')).toHaveLength(0);
    const full = await body(await as(admin).get(`/ai/assistant/conversations/${conv}`));
    expect(full.messages.map((m: Json) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(full.conversation.title).toContain('TOOL create_item');
  });

  it('keeps conversations per person and context, deletable', async () => {
    const conv = await chat();
    await say(conv, 'hello');
    const mine = await body(await as(admin).get(`/ai/assistant/conversations?board_id=${leadsId}`));
    expect(mine.data.map((c: Json) => c.id)).toContain(conv);
    expect((await body(await as(bob).get(`/ai/assistant/conversations?board_id=${leadsId}`))).data).toEqual([]);
    expect((await as(bob).get(`/ai/assistant/conversations/${conv}`)).status).toBe(404);
    expect((await as(bob).post(`/ai/assistant/conversations/${conv}/messages`, { text: 'hi' })).status).toBe(404);
    expect((await as(admin).del(`/ai/assistant/conversations/${conv}`)).status).toBe(200);
    expect((await as(admin).get(`/ai/assistant/conversations/${conv}`)).status).toBe(404);
  });
});

describe('assistant — isolation and limits', () => {
  it('never more than the person: boards they cannot see do not exist, viewers get read tools only', async () => {
    expect((await as(bob).post('/ai/assistant/conversations', { board_id: privateId })).status).toBe(404);
    expect((await t.api(otherAdmin, otherId).post('/ai/assistant/conversations', { board_id: leadsId })).status).toBe(
      404,
    );
    const conv = await chat({ board_id: leadsId }, bob);
    const { last } = await say(conv, `TOOL get_board {"board_id":"${privateId}"}`, bob);
    expect(last.type).toBe('done');
    expect(JSON.stringify(requests[1]!.messages.at(-1))).toContain('not_found');
    expect(JSON.stringify(requests[1]!.messages)).not.toContain('Admin only');
    // A viewer's model is not even offered write tools; a call to one is refused.
    const vconv = await chat({ board_id: leadsId }, carol);
    requests.length = 0;
    const v = await say(vconv, `TOOL create_item {"board_id":"${leadsId}","name":"By viewer"}`, carol);
    expect((requests[0]!.tools ?? []).some((x) => (x as Json).name === 'create_item')).toBe(false);
    expect(v.last.message.actions).toEqual([]);
    expect(JSON.stringify(requests[1]!.messages.at(-1))).toContain('tool_not_allowed');
  });

  it('stops at the step limit, the daily limit and the account budget', async () => {
    await assistant({ max_steps: 1 });
    const conv = await chat();
    const { last } = await say(
      conv,
      `TOOL get_board {"board_id":"${leadsId}"}\nTOOL get_board {"board_id":"${leadsId}"}`,
    );
    expect(last.message.error).toBe('limit_steps');
    await assistant({ daily_messages_per_user: 1 });
    const res = await as(admin).post(`/ai/assistant/conversations/${conv}/messages`, { text: 'again' });
    expect(res.status).toBe(429);
    await assistant({});
    await as(admin).patch('/ai/settings', { monthly_budget_usd: 0.000001 });
    try {
      const n = requests.length;
      const { last: l2 } = await say(conv, 'hello');
      expect(l2).toMatchObject({ type: 'error', code: 'ai_budget_exceeded' });
      expect(requests.length).toBe(n);
    } finally {
      await as(admin).patch('/ai/settings', { monthly_budget_usd: null });
    }
  });
});
