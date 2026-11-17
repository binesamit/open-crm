// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { and, eq, isNull } from 'drizzle-orm';
import { type AiClientFactory, type AnthropicLike, createAiClient, scriptedAnthropic } from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activityLog, agentRuns, items } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Prod — the AI panel from anywhere, against the scripted model (`TOOL <name> <json>` lines play as tool
 * calls): chats about a document, a dashboard or the whole account, and chats with one of the account's agents —
 * its instructions and model, only its boards that the person can see, its changes approved by the person, each
 * message a `chat` run within the agent's quotas.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let wsId: string;
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
const as = (cookie: string) => t.api(cookie, acmeId);

const events = async (res: Response) =>
  (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()) as Json);

const chat = async (ctx: Json, cookie = admin) => {
  const res = await as(cookie).post('/ai/assistant/conversations', ctx);
  const json = await body(res);
  expect(res.status, JSON.stringify(json)).toBe(201);
  return json.id as string;
};
const say = async (conv: string, text: string, cookie = admin) => {
  const res = await as(cookie).post(`/ai/assistant/conversations/${conv}/messages`, { text });
  expect(res.status).toBe(200);
  const evs = await events(res);
  return { evs, last: evs.at(-1)! };
};
/** The text of the last user turn sent to the model (the context block comes first). */
const lastUserText = () => {
  const msgs = requests.at(-1)!.messages;
  const user = [...msgs].reverse().find((m) => m.role === 'user' && Array.isArray(m.content))!;
  return (user.content as Anthropic.TextBlockParam[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
};

const newAgent = async (extra: Json = {}) => {
  const res = await as(admin).post('/agents', {
    name: `סוכן ${Math.random().toString(36).slice(2, 7)}`,
    role: 'מכירות',
    instructions: 'You are the sales agent. Always sign as SALES-BOT.',
    connection_id: connectionId,
    model: 'claude-opus-5-5',
    tools: ['get_board', 'query_items', 'create_item'],
    boards: [{ board_id: leadsId, level: 'edit' }],
    approval_mode: 'autonomous',
    ...extra,
  });
  const json = await body(res);
  expect(res.status, JSON.stringify(json)).toBe(201);
  return json;
};

beforeAll(async () => {
  t = await createTestContext({ aiClient });
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const a = as(admin);
  connectionId = (
    await body(
      await a.post('/ai/connections', { name: 'Claude', provider: 'anthropic', api_key: 'sk-ant-test-0000000000' }),
    )
  ).id;
  wsId = (await body(await a.get('/workspaces'))).data[0].id;
  leadsId = (await body(await a.post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  privateId = (await body(await a.post('/boards', { name: 'Admin only', workspace_id: wsId, kind: 'private' }))).id;
  await a.post(`/boards/${leadsId}/items`, { name: 'Dana' });
  await a.patch('/ai/settings', {
    enabled: true,
    assistant: {
      enabled: true,
      connection_id: connectionId,
      model: 'claude-sonnet-5-5',
      roles: ['member', 'viewer'],
      max_steps: 8,
      max_usd_per_message: 0.5,
      daily_messages_per_user: 100,
    },
  });
});
afterAll(() => t.close());
beforeEach(() => {
  requests.length = 0;
});

describe('the panel anywhere — places', () => {
  it('a chat about the whole account, and one about a document (its id in the context, its name as data)', async () => {
    const account = await chat({});
    await say(account, 'hello');
    expect(lastUserText()).not.toContain('doc_id');

    const doc = await body(await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Q4 plan' }));
    const conv = await chat({ doc_id: doc.id });
    const got = await body(await as(admin).get(`/ai/assistant/conversations/${conv}`));
    expect(got.conversation).toMatchObject({ doc_id: doc.id, board_id: null, item_id: null, agent_id: null });
    await say(conv, 'summarise');
    expect(lastUserText()).toContain(`doc_id: ${doc.id}`);
    expect(lastUserText()).toContain('document: Q4 plan');
    // Listed per place: the document's chats are not the account's.
    const docChats = await body(await as(admin).get(`/ai/assistant/conversations?doc_id=${doc.id}`));
    expect(docChats.data.map((c: Json) => c.id)).toEqual([conv]);
    expect((await body(await as(admin).get('/ai/assistant/conversations'))).data.map((c: Json) => c.id)).toEqual([
      account,
    ]);
  });

  it('a document or a dashboard the person cannot open does not exist for the panel', async () => {
    const secret = await body(await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Salaries', kind: 'private' }));
    expect((await as(bob).post('/ai/assistant/conversations', { doc_id: secret.id })).status).toBe(404);
    expect((await as(bob).get(`/ai/assistant/conversations?doc_id=${secret.id}`)).status).toBe(404);
  });

  it('a dashboard: its boards that the person can see are in the context, the others are not', async () => {
    const dash = await body(
      await as(admin).post(`/workspaces/${wsId}/dashboards`, { name: 'Sales', board_ids: [leadsId, privateId] }),
    );
    const conv = await chat({ dashboard_id: dash.id }, bob);
    await say(conv, 'what stands out?', bob);
    const text = lastUserText();
    expect(text).toContain(`dashboard_id: ${dash.id}`);
    expect(text).toContain(leadsId);
    expect(text).not.toContain(privateId);
  });
});

describe('the panel anywhere — chat with an agent', () => {
  it('lists the agents I may chat with; chat off or paused agents are not offered and refuse a chat', async () => {
    const on = await newAgent();
    const off = await newAgent({ triggers: { chat: false } });
    const listed = (await body(await as(bob).get('/ai/assistant/agents'))).data.map((x: Json) => x.id);
    expect(listed).toContain(on.id);
    expect(listed).not.toContain(off.id);
    const refused = await as(bob).post('/ai/assistant/conversations', { agent_id: off.id });
    expect(refused.status).toBe(403);
    expect((await body(refused)).error.message).toBe('agent_chat_off');
    await as(admin).patch(`/agents/${on.id}`, { is_active: false });
    expect((await body(await as(bob).get('/ai/assistant/agents'))).data.map((x: Json) => x.id)).not.toContain(on.id);
  });

  it('answers as the agent: its instructions and model, a chat run; reads only its boards I can see', async () => {
    const agent = await newAgent();
    const conv = await chat({ board_id: leadsId, agent_id: agent.id }, bob);
    const { last } = await say(
      conv,
      `TOOL get_board {"board_id":"${leadsId}"}\nTOOL get_board {"board_id":"${privateId}"}`,
      bob,
    );
    expect(last.type).toBe('done');
    const req = requests[0]!;
    expect(JSON.stringify(req.system)).toContain('Always sign as SALES-BOT');
    expect(req.model).toBe('claude-opus-5-5');
    // The agent's tools only (no delete_item, which it was not given).
    expect((req.tools ?? []).map((x) => (x as { name: string }).name).sort()).toEqual(
      ['create_item', 'get_board', 'query_items'].sort(),
    );
    // Its own board reads; the board it is not on does not exist for it.
    const results = JSON.stringify(requests.at(-1)!.messages);
    expect(results).toContain('Leads');
    expect(results).not.toContain('Admin only');
    const runs = await t.db.select().from(agentRuns).where(eq(agentRuns.agentId, agent.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'chat', status: 'succeeded' });
    expect(runs[0]!.meta).toMatchObject({ conversation_id: conv, untrusted_requester: true, board_scope: [leadsId] });
  });

  it('its changes wait for my approval, then run as me, marked with the agent', async () => {
    const agent = await newAgent();
    const conv = await chat({ agent_id: agent.id }, bob);
    const { last } = await say(conv, `TOOL create_item {"board_id":"${leadsId}","name":"From the agent"}`, bob);
    const msg = last.message;
    expect(msg.actions).toHaveLength(1);
    expect(msg.actions[0].status).toBe('pending');
    const named = () =>
      t.db
        .select()
        .from(items)
        .where(and(eq(items.boardId, leadsId), eq(items.name, 'From the agent'), isNull(items.deletedAt)));
    expect(await named()).toHaveLength(0);
    const res = await as(bob).post(`/ai/assistant/messages/${msg.id}/actions`, { approve: [msg.actions[0].id] });
    const decided = await body(res);
    expect(res.status, JSON.stringify(decided)).toBe(200);
    expect(decided.message.actions[0].status).toBe('done');
    const [created] = await named();
    expect(created).toBeDefined();
    const [ev] = await t.db.select().from(activityLog).where(eq(activityLog.itemId, created!.id));
    expect((ev!.payload as Json).meta.ai).toMatchObject({ source: 'assistant', agent_id: agent.id });
    // I may undo it (it ran as me).
    expect((await as(bob).post(`/activity/batches/${decided.batch_id}/undo`, {})).status).toBe(200);
  });

  it("the agent's runs a day are the limit", async () => {
    const agent = await newAgent({ limits: { max_runs_per_day: 1 } });
    const conv = await chat({ agent_id: agent.id }, bob);
    await say(conv, 'one', bob);
    const res = await as(bob).post(`/ai/assistant/conversations/${conv}/messages`, { text: 'two' });
    expect(res.status).toBe(429);
    expect((await body(res)).error.message).toBe('quota_runs_per_day');
  });
});

describe('deleting the agent after a chat', () => {
  it('deletes an agent right after a chat and an approved change (no lingering run blocks it)', async () => {
    const agent = await newAgent();
    const conv = await chat({ agent_id: agent.id });
    const { last } = await say(conv, `TOOL create_item {"board_id":"${leadsId}","name":"Repro ${agent.id}"}`);
    const msg = last.message;
    const res = await as(admin).post(`/ai/assistant/messages/${msg.id}/actions`, { approve: [msg.actions[0].id] });
    expect(res.status).toBe(200);
    const del = await as(admin).del(`/agents/${agent.id}`);
    expect(del.status).toBe(200);
  }, 30_000);
});
