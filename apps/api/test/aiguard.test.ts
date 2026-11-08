// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { and, eq, isNull } from 'drizzle-orm';
import { aiTool, type AiToolDef } from '@bines/shared';
import { type AiClientFactory, type AnthropicLike, createAiClient } from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agentApprovals, aiMessages, items, users } from '../src/db/schema';
import { findAccountById, findMembership } from '../src/modules/accounts/accounts.repo';
import { decideApprovalRow, findAgent, findRunById, listSteps, updateRunRow } from '../src/modules/agents/agents.repo';
import { executeRun as executeAgentRun } from '../src/modules/agents/engine/loop';
import { createAgentRun } from '../src/modules/agents/runs.service';
import { loadAiSettings } from '../src/modules/ai/ai.service';
import { aiWriteLimiter, guardToolCall } from '../src/modules/ai/tools/guard';
import {
  decideAssistantActions,
  prepareAssistantMessage,
  sendAssistantMessage,
} from '../src/modules/ai2/assistant.service';
import type { Actor } from '../src/modules/items/items.service';
import { runTool } from '../src/modules/mcp/mcp.server';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * The shared AI tool gate (aiguard): the MCP server, the agents and the assistant all run tools through
 * `guardToolCall` — a read-only plan runs read tools only over MCP and nothing for the account's own AI (agents, the
 * assistant — plan-lock), a suspended one nothing, the plan's features hold, the
 * change rate is one count for all three, and an approval given before a downgrade does not run after it.
 */
let t: TestContext;
let owner: string;
let admin: string;
let acmeId: string;
let leadsId: string;
let connectionId: string;
let openV: string;
let noFlowsV: string;
let noAiV: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

// ---- a scripted model ----
type Turn = { content: Anthropic.ContentBlock[]; stop: string };
let script: (n: number) => Turn = () => end('ok');
let seqId = 0;
const toolUse = (name: string, input: Json) =>
  ({ type: 'tool_use', id: `toolu_g_${++seqId}`, name, input }) as Anthropic.ToolUseBlock;
const end = (text: string): Turn => ({
  content: [{ type: 'text', text, citations: null } as Anthropic.TextBlock],
  stop: 'end_turn',
});
const plays =
  (...calls: [string, Json][]) =>
  (n: number): Turn =>
    n < calls.length ? { content: [toolUse(calls[n]![0], calls[n]![1])], stop: 'tool_use' } : end('done');
const fakeAnthropic: AnthropicLike = {
  messages: {
    create: async (params) => {
      const n = params.messages.filter((m) => m.role === 'assistant').length;
      const turn = script(n);
      return {
        id: `msg_${n}`,
        type: 'message',
        role: 'assistant',
        model: params.model,
        content: turn.content,
        stop_reason: turn.stop,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as unknown as Anthropic.Message;
    },
  },
  models: { list: async () => ({ data: [] }) },
};
const aiClient: AiClientFactory = (conn) => createAiClient(conn, { anthropic: fakeAnthropic });

// ---- helpers ----
const as = (cookie = admin) => t.api(cookie, acmeId);
const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const setPlan = async (status: string, version = openV) => {
  const res = await t.api(owner).put(`/platform/accounts/${acmeId}/subscription`, { plan_version_id: version, status });
  expect(res.status, await res.clone().text()).toBe(200);
};
const itemNamed = async (name: string) =>
  (
    await t.db
      .select()
      .from(items)
      .where(and(eq(items.name, name), isNull(items.deletedAt)))
  ).length;
const adminActor = async (): Promise<Actor> => {
  const [u] = await t.db.select().from(users).where(eq(users.email, 'admin@acme.test'));
  const account = (await findAccountById(t.db, acmeId))!;
  const m = (await findMembership(t.db, acmeId, u!.id))!;
  return {
    ctx: { account, accountId: acmeId, role: m.role as Actor['ctx']['role'], membershipId: m.id },
    user: {
      id: u!.id,
      email: u!.email,
      name: u!.name,
      emailVerified: true,
      isPlatformOwner: false,
      locale: u!.locale,
      timezone: u!.timezone,
    } as Actor['user'],
  };
};

// MCP
const fetchApp = (url: string | URL | Request, init?: RequestInit) =>
  t.app.request(url instanceof Request ? url : String(url), init) as Promise<Response>;
const mint = async (scopes: string[]) =>
  (await body(await as().post('/auth/tokens', { name: 'Claude Code', scopes }))).token as string;
const connect = async (token: string) => {
  const client = new Client({ name: 'aiguard', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${WEB_ORIGIN}/mcp`), {
      fetch: fetchApp,
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
};
const call = async (client: Client, name: string, args: Json = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as Json;
  const parsed = JSON.parse(res.content?.[0]?.text ?? '{}') as Json;
  return { isError: !!res.isError, data: parsed, error: parsed.error as Json };
};
const SCOPES = ['boards:read', 'items:write'];

// Agents
const newAgent = async (extra: Json = {}) => {
  const res = await as().post('/agents', {
    name: `סוכן ${Math.random().toString(36).slice(2, 7)}`,
    connection_id: connectionId,
    model: 'claude-opus-5-5',
    tools: ['get_board', 'create_item'],
    boards: [{ board_id: leadsId, level: 'edit' }],
    approval_mode: 'autonomous',
    ...extra,
  });
  const json = await body(res);
  expect(res.status, JSON.stringify(json)).toBe(201);
  return json.id as string;
};
/** A run started by the engine itself (a schedule / trigger) — no HTTP request that the plan could stop. */
const engineRun = async (agentId: string) => {
  const found = (await findAgent(t.db, acmeId, agentId))!;
  const id = await createAgentRun(t.deps, found.a, { trigger: 'manual', prompt: 'go', item: null, requestedBy: null });
  return (await findRunById(t.db, id))!;
};
const toolOutcomes = async (runId: string) =>
  (await listSteps(t.db, runId)).filter((s) => s.kind === 'tool').map((s) => [s.tool, s.outcome]);

// Assistant
const events = async (res: Response) =>
  (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()) as Json);
const chat = async () =>
  (await body(await as().post('/ai/assistant/conversations', { board_id: leadsId }))).id as string;
/** One message straight through the service (the REST route itself is closed in a read-only account). */
const tell = async (conv: string, text: string) => {
  const a = await adminActor();
  const prepared = await prepareAssistantMessage(t.deps, a, conv, text);
  return sendAssistantMessage(t.deps, a, prepared, text, () => undefined);
};

beforeAll(async () => {
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
  ).account.id;
  admin = await join('admin@acme.test');
  openV = (await body(await t.api(owner).post('/platform/plans', { name: 'Open', version: { features: [] } })))
    .versions[0].id;
  const all = ['ai', 'automations_advanced', 'api', 'extensions', 'flows', 'dashboards', 'docs', 'forms', 'guests'];
  noFlowsV = (
    await body(
      await t
        .api(owner)
        .post('/platform/plans', { name: 'No flows', version: { features: all.filter((f) => f !== 'flows') } }),
    )
  ).versions[0].id;
  noAiV = (
    await body(
      await t
        .api(owner)
        .post('/platform/plans', { name: 'No AI', version: { features: all.filter((f) => f !== 'ai') } }),
    )
  ).versions[0].id;
  await setPlan('active');

  expect((await as().patch('/ai/settings', { enabled: true })).status).toBe(200);
  connectionId = (
    await body(
      await as().post('/ai/connections', {
        name: 'Claude',
        provider: 'anthropic',
        api_key: 'sk-ant-api03-aiguard-test-0123456789',
      }),
    )
  ).id;
  await as().patch('/ai/settings', {
    assistant: {
      enabled: true,
      connection_id: connectionId,
      model: 'claude-sonnet-5-5',
      roles: ['member', 'viewer'],
      max_steps: 8,
      max_usd_per_message: 0.5,
      daily_messages_per_user: 1000,
    },
  });
  const wsId = (await body(await as().get('/workspaces'))).data[0].id;
  leadsId = (await body(await as().post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
});
afterAll(() => t.close());
beforeEach(async () => {
  script = () => end('ok');
  aiWriteLimiter.clear();
  await setPlan('active');
});

describe('aiguard — MCP', () => {
  it('read_only: a write tool is refused, a read tool runs', async () => {
    const client = await connect(await mint(SCOPES));
    await setPlan('read_only');
    const write = await call(client, 'create_item', { board_id: leadsId, name: 'mcp ro' });
    expect(write.isError).toBe(true);
    expect(write.error.code).toBe('plan_read_only');
    expect(await itemNamed('mcp ro')).toBe(0);
    const read = await call(client, 'get_board', { board_id: leadsId });
    expect(read.isError).toBe(false);
    await client.close();
  });

  it('suspended: the server answers nothing, and the tool gate refuses even a read', async () => {
    const token = await mint(SCOPES);
    await setPlan('suspended');
    await expect(connect(token)).rejects.toThrow();
    const a = await adminActor();
    const principal = {
      actor: a,
      scopes: SCOPES,
      tokenId: 'tok_test',
      client: 'test',
      via: 'token' as const,
      ai: await loadAiSettings(t.db, acmeId),
      support: null,
    };
    const res = await runTool(t.deps, principal, aiTool('get_board') as AiToolDef, { board_id: leadsId });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('plan_suspended');
  });
});

describe('aiguard — agents', () => {
  // plan-lock (product decision): no AI at all in a read-only / suspended account — the run is recorded as skipped, nothing runs.
  it('read_only: the run does not start (skipped, plan_read_only) — not even its reads', async () => {
    const agentId = await newAgent();
    await setPlan('read_only');
    script = plays(['get_board', { board_id: leadsId }], ['create_item', { board_id: leadsId, name: 'agent ro' }]);
    const run = await engineRun(agentId);
    expect(run).toMatchObject({ status: 'skipped', skipReason: 'plan_read_only' });
    expect(await toolOutcomes(run.id)).toEqual([]);
    expect(await itemNamed('agent ro')).toBe(0);
  });

  it('read_only: the tool gate refuses even a read for an agent', async () => {
    await setPlan('read_only');
    await expect(
      guardToolCall(t.deps, {
        surface: 'agent',
        actor: await adminActor(),
        tool: { name: 'get_board', risk: 'read' },
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'plan_read_only' });
  });

  it('suspended: the run does not start (skipped, plan_suspended)', async () => {
    const agentId = await newAgent();
    await setPlan('suspended');
    script = plays(['get_board', { board_id: leadsId }]);
    const run = await engineRun(agentId);
    expect(run).toMatchObject({ status: 'skipped', skipReason: 'plan_suspended' });
  });

  it('an approval given before a downgrade does not run after it (read_only, then a plan without AI)', async () => {
    for (const [status, version, reason] of [
      ['read_only', openV, 'plan_read_only'],
      ['active', noAiV, 'plan_feature_unavailable'],
    ] as const) {
      const agentId = await newAgent({ approval_mode: 'learner' });
      const name = `approved then ${reason}`;
      script = plays(['create_item', { board_id: leadsId, name }]);
      const started = await engineRun(agentId);
      expect(started.status).toBe('waiting_approval');
      const [approval] = await t.db
        .select()
        .from(agentApprovals)
        .where(and(eq(agentApprovals.runId, started.id), eq(agentApprovals.status, 'pending')));
      // Approved while the plan allowed it …
      await decideApprovalRow(t.db, approval!.id, { status: 'approved' });
      // … executed after the downgrade.
      await setPlan(status, version);
      await updateRunRow(t.db, started.id, { status: 'queued' });
      const done = (await executeAgentRun(t.deps, started.id))!;
      expect(done.status).toBe('failed');
      expect(done.error).toBe(reason);
      expect(await itemNamed(name)).toBe(0);
      await setPlan('active');
    }
  });
});

describe('aiguard — assistant', () => {
  // plan-lock (product decision): the assistant does not work at all in a read-only / suspended account — not even reads.
  it('read_only: the REST route is closed and the service refuses even a read', async () => {
    const conv = await chat();
    await setPlan('read_only');
    expect((await as().post(`/ai/assistant/conversations/${conv}/messages`, { text: 'hi' })).status).toBe(423);
    script = plays(['get_board', { board_id: leadsId }], ['create_item', { board_id: leadsId, name: 'asst ro' }]);
    await expect(tell(conv, 'read then write')).rejects.toMatchObject({ code: 'plan_read_only' });
    expect(await t.db.select().from(aiMessages).where(eq(aiMessages.conversationId, conv))).toEqual([]);
    expect(await itemNamed('asst ro')).toBe(0);
  });

  it('suspended: even a read is refused', async () => {
    const conv = await chat();
    await setPlan('suspended');
    script = plays(['get_board', { board_id: leadsId }]);
    await expect(tell(conv, 'read')).rejects.toMatchObject({ code: 'plan_suspended' });
    expect(await t.db.select().from(aiMessages).where(eq(aiMessages.conversationId, conv))).toEqual([]);
  });

  it('an action approved after a downgrade fails with plan_read_only and changes nothing', async () => {
    const conv = await chat();
    script = plays(['create_item', { board_id: leadsId, name: 'asst approved late' }]);
    const res = await as().post(`/ai/assistant/conversations/${conv}/messages`, { text: 'add it' });
    const last = (await events(res)).at(-1)!;
    const message = last.message as Json;
    expect(message.actions).toHaveLength(1);
    await setPlan('read_only');
    await expect(
      decideAssistantActions(t.deps, await adminActor(), message.id, { approve: [message.actions[0].id], reject: [] }),
    ).rejects.toMatchObject({ code: 'plan_read_only' });
    expect(await itemNamed('asst approved late')).toBe(0);
  });
});

describe('aiguard — shared rules', () => {
  it('one change rate for MCP and the assistant (the account setting)', async () => {
    expect((await as().patch('/ai/settings', { write_rate_per_minute: 2 })).status).toBe(200);
    try {
      const conv = await chat();
      script = plays(['create_item', { board_id: leadsId, name: 'rate via assistant' }]);
      const last = (await events(await as().post(`/ai/assistant/conversations/${conv}/messages`, { text: 'x' }))).at(
        -1,
      )!;
      const message = last.message as Json;
      const client = await connect(await mint(SCOPES));
      expect((await call(client, 'create_item', { board_id: leadsId, name: 'rate 1' })).isError).toBe(false);
      expect((await call(client, 'create_item', { board_id: leadsId, name: 'rate 2' })).isError).toBe(false);
      // The same person's third change — through the assistant — is over the shared limit.
      const out = await decideAssistantActions(t.deps, await adminActor(), message.id, {
        approve: [message.actions[0].id],
        reject: [],
      });
      expect(out.message.actions[0]).toMatchObject({ status: 'failed', error: 'ai_write_rate_limited' });
      expect(await itemNamed('rate via assistant')).toBe(0);
      const third = await call(client, 'create_item', { board_id: leadsId, name: 'rate 3' });
      expect(third.error.code).toBe('rate_limited');
      await client.close();
    } finally {
      await as().patch('/ai/settings', { write_rate_per_minute: 60 });
    }
  });

  it('a plan without flows: flows_* changes are refused, reads pass, other tools pass', async () => {
    await setPlan('active', noFlowsV);
    const a = await adminActor();
    const guard = (name: string, risk: 'read' | 'write') =>
      guardToolCall(t.deps, { surface: 'agent', actor: a, tool: { name, risk }, input: {}, count: false });
    await expect(guard('flows_draft_create', 'write')).rejects.toMatchObject({
      code: 'plan_feature_unavailable',
      details: { feature: 'flows', upgrade: true },
    });
    await expect(guard('flows_list', 'read')).resolves.toBeUndefined();
    await expect(guard('create_item', 'write')).resolves.toBeUndefined();
  });

  it('support in view mode: changes refused, reads pass', async () => {
    const a = await adminActor();
    a.ctx.support = { grantId: 'g', mode: 'view', expiresAt: new Date(Date.now() + 60_000) };
    const guard = (name: string, risk: 'read' | 'write') =>
      guardToolCall(t.deps, { surface: 'assistant', actor: a, tool: { name, risk }, input: {}, count: false });
    await expect(guard('create_item', 'write')).rejects.toMatchObject({ code: 'support_read_only' });
    await expect(guard('get_board', 'read')).resolves.toBeUndefined();
  });
});
