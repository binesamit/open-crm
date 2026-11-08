// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import { type AiClientFactory, type AnthropicLike, createAiClient } from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aiUsage } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * "Improve with AI" in the agent editor: the chosen connection rewrites the instructions from the
 * editor's state; the model sees only the tools an agent can have and the boards / columns the person can see;
 * nothing is saved; usage is recorded; who may ask, AI off and the AI change rate are enforced.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let wsId: string;
let leadsId: string;
let secretBoardId: string;
let connectionId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

let answer = 'הוראות משופרות';
let stop = 'end_turn';
const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
const fakeAnthropic: AnthropicLike = {
  messages: {
    create: async (params) => {
      requests.push(structuredClone(params));
      return {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: params.model,
        content: [{ type: 'text', text: answer, citations: null }],
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 300, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as unknown as Anthropic.Message;
    },
  },
  models: { list: async () => ({ data: [] }) },
};
const aiClient: AiClientFactory = (conn) => createAiClient(conn, { anthropic: fakeAnthropic });

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const prompt = () => {
  const m = requests.at(-1)!.messages[0]!;
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
};
const improve = (cookie: string, extra: Json = {}) =>
  as(cookie).post('/agents/improve-instructions', {
    connection_id: connectionId,
    model: 'claude-opus-5-5',
    name: 'נציג שירות',
    role: 'עונה ללקוחות',
    instructions: 'לענות ללקוחות.',
    tools: ['get_board', 'create_update', 'drop_everything'],
    boards: [
      { board_id: leadsId, level: 'edit' },
      { board_id: secretBoardId, level: 'view' },
    ],
    ...extra,
  });

beforeAll(async () => {
  t = await createTestContext({ aiClient });
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme-improve',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  expect((await as(admin).patch('/ai/settings', { enabled: true, agent_creators: 'members' })).status).toBe(200);
  connectionId = (
    await body(
      await as(admin).post('/ai/connections', {
        name: 'Claude',
        provider: 'anthropic',
        api_key: 'sk-ant-test-0000000000',
      }),
    )
  ).id;
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  leadsId = (await body(await as(admin).post('/boards', { name: 'לידים', workspace_id: wsId }))).id;
  await as(admin).post(`/boards/${leadsId}/columns`, { title: 'סטטוס טיפול', type: 'status' });
  secretBoardId = (
    await body(await as(admin).post('/boards', { name: 'משכורות סודי', workspace_id: wsId, kind: 'private' }))
  ).id;
});
afterAll(() => t.close());
beforeEach(() => {
  requests.length = 0;
  answer = 'הוראות משופרות';
  stop = 'end_turn';
});

describe('improve agent instructions', () => {
  it("rewrites from the editor's state: real tools, boards and columns as context; the answer comes back", async () => {
    answer = '```\n## המטרה\nלענות ללקוחות בנימוס.\n```';
    const res = await improve(admin, { request: 'יותר אדיב' });
    const json = await body(res);
    expect(res.status, JSON.stringify(json)).toBe(200);
    // A surrounding code fence is dropped.
    expect(json.instructions).toBe('## המטרה\nלענות ללקוחות בנימוס.');
    const text = prompt();
    expect(text).toContain('לענות ללקוחות.');
    expect(text).toContain('יותר אדיב');
    expect(text).toContain('get_board');
    expect(text).toContain('create_update');
    // A name that is not an agent tool never reaches the model.
    expect(text).not.toContain('drop_everything');
    expect(text).toContain('"לידים" (may change items)');
    expect(text).toContain('"סטטוס טיפול" (status)');
    // The system keeps the person's language and forbids invented tools / boards.
    const system = JSON.stringify(requests.at(-1)!.system);
    expect(system).toContain('Hebrew stays Hebrew');
    expect(system).toContain('Never invent tools, boards');
  });

  it('records the usage under the agent source', async () => {
    const before = await t.db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.accountId, acmeId), eq(aiUsage.source, 'agent')));
    expect((await improve(admin)).status).toBe(200);
    const after = await t.db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.accountId, acmeId), eq(aiUsage.source, 'agent')));
    const sum = (rows: typeof after) => rows.reduce((s, r) => s + r.inputTokens, 0);
    expect(sum(after) - sum(before)).toBe(300);
  });

  it('a board the person cannot see is not named to the model', async () => {
    expect((await improve(bob)).status).toBe(200);
    expect(prompt()).not.toContain('משכורות סודי');
    expect(prompt()).toContain('לידים');
    // The admin sees it.
    expect((await improve(admin)).status).toBe(200);
    expect(prompt()).toContain('משכורות סודי');
  });

  it("nothing is saved; another person's agent is not found; creators only", async () => {
    const created = await body(
      await as(admin).post('/agents', {
        name: 'Agent',
        instructions: 'מקור',
        connection_id: connectionId,
        model: 'claude-opus-5-5',
      }),
    );
    expect((await improve(admin, { agent_id: created.id })).status).toBe(200);
    expect((await body(await as(admin).get(`/agents/${created.id}`))).instructions).toBe('מקור');
    // Bob may create agents but does not manage the admin's.
    expect((await improve(bob, { agent_id: created.id })).status).toBe(404);
    await as(admin).patch('/ai/settings', { agent_creators: 'admins' });
    try {
      const res = await improve(bob);
      expect(res.status).toBe(403);
      expect((await body(res)).error.message).toBe('agents_admins_only');
    } finally {
      await as(admin).patch('/ai/settings', { agent_creators: 'members' });
    }
  });

  it('AI off, a cut answer and the AI change rate are refused', async () => {
    await as(admin).patch('/ai/settings', { enabled: false });
    try {
      const res = await improve(admin);
      expect(res.status).toBe(403);
      expect((await body(res)).error.message).toBe('ai_disabled');
    } finally {
      await as(admin).patch('/ai/settings', { enabled: true });
    }
    stop = 'max_tokens';
    expect((await body(await improve(admin))).error.message).toBe('agent_improve_cut');
    stop = 'end_turn';
    await as(admin).patch('/ai/settings', { write_rate_per_minute: 1 });
    try {
      await improve(bob);
      const res = await improve(bob);
      expect(res.status).toBe(429);
    } finally {
      await as(admin).patch('/ai/settings', { write_rate_per_minute: 60 });
    }
  });
});
