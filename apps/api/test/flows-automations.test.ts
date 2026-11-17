// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { type AiClientFactory, type AnthropicLike, createAiClient } from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityLog, auditLog, automationRuns, flowConnections, items, notifications, users } from '../src/db/schema';
import { enqueueJob } from '../src/lib/jobs';
import type * as Jobs from '../src/lib/jobs';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';

// The queue helper keeps its behaviour (no graphile schema here → false) and records its calls: a flow event must
// queue its own `automation.dispatch` — the activity trigger (0046) does not (audit 2026-10-10, automations #1).
vi.mock('../src/lib/jobs', async (importOriginal) => {
  const m = await importOriginal<typeof Jobs>();
  return { ...m, enqueueJob: vi.fn(m.enqueueJob) };
});
import type { FlowHttpRequest, FlowHttpResponse } from '../src/modules/flows/adapters/types';
import { resetFlowConnection } from '../src/modules/flows/flows.limits';
import { checkFlowFailures, setFlowHttpForTests } from '../src/modules/flows/flows.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * automations on external flows: `flow_failed` / `flow_recovered` triggers fired by the failure
 * check (once per new failure, account-wide, only for automations whose owner may see the connection), `{flow.*}`
 * texts, and the deep link of the bell (alerts and the automation's own notify) to the flow in our flows screen.
 * operating / editing flows with the AI: explain a failure, switch on / off, run again, edit an n8n
 * workflow (diff on the approval card, saved switched off unless asked), Make refused in words.
 * Every platform is a fake transport; the model is scripted.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let adminId: string;
let bobId: string;
let boardId: string;
let n8nId: string;
let makeId: string;
let aiConnectionId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

// ---- the fake platforms ----
const N8N = 'https://n8n.acme.example';
const N8N_KEY = 'n8n-api-key-000000-abcd';
const MAKE_TOKEN = 'make-token-000000-efgh';
const calls: FlowHttpRequest[] = [];
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const SECRET_HEADER = 'Bearer super-secret-value';

type Exec = { id: string; workflowId: string; status: string; startedAt: string; stoppedAt: string };
let workflows: Json[];
let executions: Exec[];
const saved: Json[] = [];

const reset = () => {
  saved.length = 0;
  workflows = [
    {
      id: 'w1',
      name: 'Leads → SMS',
      active: true,
      nodes: [
        { id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: {} },
        {
          id: 'n2',
          name: 'HTTP Request',
          type: 'n8n-nodes-base.httpRequest',
          typeVersion: 4.2,
          position: [260, 0],
          parameters: {
            method: 'POST',
            url: 'https://sms.example.com/send',
            headerParameters: { parameters: [{ name: 'Authorization', value: SECRET_HEADER }] },
          },
          credentials: { httpHeaderAuth: { id: 'c1', name: 'SMS key' } },
        },
      ],
      connections: { Webhook: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] } },
      settings: { executionOrder: 'v1', binaryMode: 'x' },
    },
    { id: 'w2', name: 'Weekly report', active: false, nodes: [], connections: {}, settings: {} },
  ];
  executions = [
    // Before anyone connected: history, never alerted.
    { id: '50', workflowId: 'w1', status: 'error', startedAt: ago(60 * 24 * 30), stoppedAt: ago(60 * 24 * 30) },
  ];
};

const reply = (status: number, json: unknown): FlowHttpResponse => ({
  status,
  ok: status < 400,
  body: JSON.stringify(json),
});

const n8n = (req: FlowHttpRequest, url: URL): FlowHttpResponse => {
  if (req.headers['X-N8N-API-KEY'] !== N8N_KEY) return reply(401, { message: 'unauthorized' });
  const p = url.pathname.replace('/api/v1', '');
  if (req.method === 'GET' && p === '/workflows') return reply(200, { data: workflows, nextCursor: null });
  const toggle = /^\/workflows\/([^/]+)\/(activate|deactivate)$/.exec(p);
  if (toggle && req.method === 'POST') {
    const wf = workflows.find((w) => w.id === toggle[1]);
    if (!wf) return reply(404, { message: 'not found' });
    wf.active = toggle[2] === 'activate';
    return reply(200, wf);
  }
  const one = /^\/workflows\/([^/]+)$/.exec(p);
  if (one && req.method === 'PUT') {
    const wf = workflows.find((w) => w.id === one[1]);
    if (!wf) return reply(404, { message: 'not found' });
    const sent = JSON.parse(req.body!) as Json;
    // n8n refuses unknown settings (additionalProperties: false).
    if (Object.keys(sent.settings ?? {}).some((k) => k === 'binaryMode'))
      return reply(400, { message: 'request/body/settings must NOT have additional properties' });
    saved.push(sent);
    Object.assign(wf, sent);
    return reply(200, wf);
  }
  if (one) {
    const wf = workflows.find((w) => w.id === one[1]);
    return wf ? reply(200, wf) : reply(404, { message: 'not found' });
  }
  if (p === '/executions') {
    const status = url.searchParams.get('status');
    const wf = url.searchParams.get('workflowId');
    return reply(200, {
      data: executions.filter((e) => (!status || e.status === status) && (!wf || e.workflowId === wf)),
      nextCursor: null,
    });
  }
  const retry = /^\/executions\/([^/]+)\/retry$/.exec(p);
  if (retry && req.method === 'POST') return reply(200, { id: '900' });
  const exec = /^\/executions\/([^/]+)$/.exec(p);
  if (exec) {
    const e = executions.find((x) => x.id === exec[1]);
    if (!e) return reply(404, { message: 'not found' });
    return reply(200, {
      ...e,
      mode: 'trigger',
      data: {
        resultData: {
          error: { message: 'SMS provider said 401', node: { name: 'HTTP Request' } },
          lastNodeExecuted: 'HTTP Request',
        },
      },
    });
  }
  return reply(404, { message: 'no route' });
};

const make = (req: FlowHttpRequest, url: URL): FlowHttpResponse => {
  if (req.headers.authorization !== `Token ${MAKE_TOKEN}`) return reply(401, { message: 'Invalid token' });
  const p = url.pathname.replace('/api/v2', '');
  if (p === '/scenarios') return reply(200, { scenarios: [{ id: 9, name: 'Invoices', isActive: true }] });
  if (/^\/scenarios\/9\/logs$/.test(p)) return reply(200, { scenarioLogs: [] });
  if (p === '/scenarios/9') return reply(200, { scenario: { id: 9, name: 'Invoices', isActive: true } });
  return reply(404, { message: 'no route' });
};

const fakeHttp = async (req: FlowHttpRequest): Promise<FlowHttpResponse> => {
  calls.push(req);
  const url = new URL(req.url);
  if (url.origin === N8N) return n8n(req, url);
  if (url.hostname === 'eu1.make.com') return make(req, url);
  throw new Error(`unexpected call ${req.url}`);
};
const callsTo = (method: string, re: RegExp) =>
  calls.filter((c) => c.method === method && re.test(new URL(c.url).pathname));

// ---- the scripted model ----
type Turn = { content: Anthropic.ContentBlock[]; stop: string };
let script: (n: number) => Turn = () => end('ok');
let lastMessages: Anthropic.MessageParam[] = [];
const use = (n: number, name: string, input: Json): Turn => ({
  content: [{ type: 'tool_use', id: `tu_${n}_${name}`, name, input } as Anthropic.ToolUseBlock],
  stop: 'tool_use',
});
const end = (text: string): Turn => ({
  content: [{ type: 'text', text, citations: null } as Anthropic.TextBlock],
  stop: 'end_turn',
});
const fakeAnthropic: AnthropicLike = {
  messages: {
    create: async (params) => {
      lastMessages = params.messages;
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
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as unknown as Anthropic.Message;
    },
  },
  models: { list: async () => ({ data: [] }) },
};
const aiClient: AiClientFactory = (conn) => createAiClient(conn, { anthropic: fakeAnthropic });

/** The tool results the model was sent in its last call, as text. */
const toolResults = () =>
  lastMessages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => (b as { type: string }).type === 'tool_result')
    .map((b) => String((b as { content: unknown }).content));

// ---- the automation engine, run by hand ----
const seen = new Set<string>();
const drain = async () => {
  const runs: string[] = [];
  for (let round = 0; round < 10; round++) {
    const rows = await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, acmeId))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (!fresh.length) break;
    for (const r of fresh) {
      seen.add(r.id);
      for (const runId of await dispatchEvent(t.deps, r.id)) {
        runs.push(runId);
        await executeRun(t.deps, runId);
      }
    }
  }
  return runs;
};
const runsOf = (automationId: string) =>
  t.db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId));
const itemsOnBoard = () =>
  t.db
    .select()
    .from(items)
    .where(and(eq(items.boardId, boardId), isNull(items.deletedAt)));

let clock = Date.now();
/** The next pass of the check: past the connection's interval. */
const pass = async () => {
  clock += 31 * 60_000;
  return checkFlowFailures(t.deps, new Date(clock));
};
const fail = (id: string, workflowId = 'w1') =>
  executions.unshift({
    id,
    workflowId,
    status: 'error',
    startedAt: new Date(clock + 60_000).toISOString(),
    stoppedAt: new Date(clock + 60_000).toISOString(),
  });

beforeAll(async () => {
  setFlowHttpForTests(fakeHttp);
  reset();
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
  const join = async (email: string) => {
    const token = t.inviteTokenFor(email);
    const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
    await t.api(cookie).post('/invitations/accept', { token });
    return cookie;
  };
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  adminId = (await t.db.select().from(users).where(eq(users.email, 'admin@acme.test')))[0]!.id;
  bobId = (await t.db.select().from(users).where(eq(users.email, 'bob@acme.test')))[0]!.id;
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Ops', workspace_id: wsId }))).id;
  // Bob may build automations on the board (an owner there).
  expect((await as(admin).put(`/boards/${boardId}/members/${bobId}`, { role: 'owner' })).status).toBe(200);
  n8nId = (
    await body(
      await as(admin).post('/flow-connections', {
        name: 'n8n שלנו',
        target: { platform: 'n8n', base_url: N8N, api_key: N8N_KEY },
      }),
    )
  ).id;
  makeId = (
    await body(
      await as(admin).post('/flow-connections', {
        name: 'Make',
        target: { platform: 'make', zone: 'eu1', team_id: 77, api_token: MAKE_TOKEN },
        settings: { alert_on_failure: false },
      }),
    )
  ).id;
  expect((await as(admin).patch('/ai/settings', { enabled: true })).status).toBe(200);
  aiConnectionId = (
    await body(
      await as(admin).post('/ai/connections', {
        name: 'Claude',
        provider: 'anthropic',
        api_key: 'sk-ant-test-0000000000',
      }),
    )
  ).id;
  expect(
    (
      await as(admin).patch('/ai/settings', {
        assistant: {
          enabled: true,
          connection_id: aiConnectionId,
          model: 'claude-sonnet-5-5',
          roles: ['member'],
          max_steps: 8,
          max_usd_per_message: 0.5,
          daily_messages_per_user: 100,
        },
      })
    ).status,
  ).toBe(200);
  // Everything so far (the connection's own events, history before connecting) is not about flows.
  await drain();
  clock = Date.now();
});
afterAll(async () => {
  setFlowHttpForTests(null);
  await t.close();
});
beforeEach(() => {
  calls.length = 0;
  script = () => end('ok');
});

const automation = async (cookie: string, recipe: Json) => {
  const res = await as(cookie).post(`/boards/${boardId}/automations`, { recipe, is_active: true });
  return { status: res.status, json: await body(res) };
};

describe('automations on external flows', () => {
  let failedId: string;

  it('a flow trigger is saved with the connection the person may see; a member cannot pick a hidden one', async () => {
    const recipe = {
      trigger: { type: 'flow_failed', connection: n8nId },
      actions: [
        { type: 'create_item', board: '@self', name: '{flow.name} · {flow.step}' },
        { type: 'notify', to: `user:${adminId}`, message: '{flow.name} נכשלה: {flow.error}' },
      ],
    };
    const ok = await automation(admin, recipe);
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    failedId = ok.json.id;
    expect(ok.json.recipe.trigger).toEqual({ type: 'flow_failed', connection: n8nId });
    // The connection is open to admins only: Bob cannot point at it.
    const hidden = await automation(bob, recipe);
    expect(hidden.status).toBe(422);
    expect(JSON.stringify(hidden.json)).toContain('flow_connection_not_found');
  });

  it('a new failure fires the automation once, with {flow.*}; the notify opens the flow', async () => {
    fail('104');
    vi.mocked(enqueueJob).mockClear();
    expect(await pass()).toBe(1);
    // The `flow.failed` event queued its dispatch (in production the queue exists; here it reports none).
    const queued = vi.mocked(enqueueJob).mock.calls.filter((c) => c[1] === 'automation.dispatch');
    expect(queued).toHaveLength(1);
    expect(queued[0]![2]).toMatchObject({ account_id: acmeId, event_id: expect.any(String) });
    const runs = await drain();
    expect(runs).toHaveLength(1);
    const [run] = await runsOf(failedId);
    expect(run).toMatchObject({
      status: 'succeeded',
      itemId: null,
      eventType: 'flow.failed',
      eventId: queued[0]![2].event_id,
    });
    // {flow.name} · {flow.step}: the item the run created.
    expect((await itemsOnBoard()).map((i) => i.name)).toContain('Leads → SMS · HTTP Request');
    // The automation's message: to the person, with the flow to open.
    const mine = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, adminId), eq(notifications.type, 'automation')));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.payload).toMatchObject({
      excerpt: 'Leads → SMS נכשלה: SMS provider said 401',
      flow: { connection_id: n8nId, flow_id: 'w1', run_id: '104' },
    });
    // The same failure on the next pass: nothing new.
    expect(await pass()).toBe(0);
    expect(await drain()).toHaveLength(0);
    expect(await runsOf(failedId)).toHaveLength(1);
    // Two more failures: one run each.
    fail('105');
    fail('106', 'w2');
    expect(await pass()).toBe(2);
    expect(await drain()).toHaveLength(2);
    expect(await runsOf(failedId)).toHaveLength(3);
  });

  it('the bell: the alert and the automation message both deep-link to the flow and the run', async () => {
    const list = await body(await as(admin).get('/me/notifications'));
    const alerts = list.data.filter((n: Json) => n.type === 'flow_failed').map((n: Json) => n.flow);
    expect(alerts).toContainEqual({ connection_id: n8nId, flow_id: 'w1', run_id: '104' });
    const auto = list.data.find((n: Json) => n.type === 'automation');
    expect(auto.flow).toMatchObject({ connection_id: n8nId });
    expect(auto.board).toMatchObject({ id: boardId, name: 'Ops' });
    expect(auto.item).toBeNull();
  });

  it('only a chosen flow; alerts off still feeds automations; another member’s automation never hears it', async () => {
    // A member's automation on "any connection": saved, but the n8n connection is the admins' — never runs.
    const bobs = await automation(bob, {
      trigger: { type: 'flow_failed' },
      actions: [{ type: 'create_item', board: '@self', name: 'bob {flow.name}' }],
    });
    expect(bobs.status, JSON.stringify(bobs.json)).toBe(201);
    const onlyW2 = await automation(admin, {
      trigger: { type: 'flow_failed', connection: n8nId, flow: 'w2' },
      actions: [{ type: 'create_item', board: '@self', name: 'w2 {flow.error}' }],
    });
    await as(admin).patch(`/flow-connections/${n8nId}`, { settings: { alert_on_failure: false } });
    const before = (await t.db.select().from(notifications).where(eq(notifications.type, 'flow_failed'))).length;
    fail('107', 'w1');
    expect(await pass()).toBe(1);
    await drain();
    expect(await runsOf(onlyW2.json.id)).toHaveLength(0);
    expect(await runsOf(bobs.json.id)).toHaveLength(0);
    expect(await runsOf(failedId)).toHaveLength(4);
    // Alerts are off: no bell, the automation still ran.
    expect((await t.db.select().from(notifications).where(eq(notifications.type, 'flow_failed'))).length).toBe(before);
    fail('108', 'w2');
    await pass();
    await drain();
    expect(await runsOf(onlyW2.json.id)).toHaveLength(1);
    expect((await itemsOnBoard()).some((i) => i.name.startsWith('bob'))).toBe(false);
    await as(admin).patch(`/automations/${bobs.json.id}`, { is_active: false });
    await as(admin).patch(`/automations/${onlyW2.json.id}`, { is_active: false });
  });

  it('flow_recovered: once, when the newest run of a failing flow succeeded', async () => {
    const rec = await automation(admin, {
      trigger: { type: 'flow_recovered', connection: 'any' },
      actions: [{ type: 'create_item', board: '@self', name: 'חזרה לעבוד: {flow.name} ({flow.status})' }],
    });
    expect(rec.status, JSON.stringify(rec.json)).toBe(201);
    // Still failing: nothing.
    await pass();
    await drain();
    expect(await runsOf(rec.json.id)).toHaveLength(0);
    executions.unshift({
      id: '120',
      workflowId: 'w1',
      status: 'success',
      startedAt: new Date(clock + 120_000).toISOString(),
      stoppedAt: new Date(clock + 120_000).toISOString(),
    });
    await pass();
    await drain();
    expect(await runsOf(rec.json.id)).toHaveLength(1);
    expect((await itemsOnBoard()).map((i) => i.name)).toContain('חזרה לעבוד: Leads → SMS (recovered)');
    // Heard once.
    await pass();
    await drain();
    expect(await runsOf(rec.json.id)).toHaveLength(1);
    await as(admin).patch(`/automations/${rec.json.id}`, { is_active: false });
    await as(admin).patch(`/automations/${failedId}`, { is_active: false });
  });
});

// --- the assistant: operate and edit ----

const events = async (res: Response) =>
  (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()) as Json);
const ask = async (text: string) => {
  // An account-level conversation (the flows screen's "ask the assistant": no board).
  const conv = await body(await as(admin).post('/ai/assistant/conversations', {}));
  expect(conv.board_id).toBeNull();
  const res = await as(admin).post(`/ai/assistant/conversations/${conv.id}/messages`, { text });
  expect(res.status).toBe(200);
  return (await events(res)).at(-1)!.message as Json;
};
const approve = async (m: Json) =>
  body(await as(admin).post(`/ai/assistant/messages/${m.id}/actions`, { approve: m.actions.map((x: Json) => x.id) }));
const auditOf = (action: string) => t.db.select().from(auditLog).where(eq(auditLog.action, action));

describe('the assistant operates and edits flows', () => {
  // Every test here calls the same two connections, and their call budget (30 a minute, refilled by the wall clock) is
  // the module's: whether an approved action met an empty bucket ("rate_limited") depended on how fast the tests before
  // it ran (failed under the parallel suite's load in n10 / n11). Each test starts with a full budget
  // and no kept answers — the fake platform holds what earlier tests changed.
  beforeEach(() => {
    resetFlowConnection(n8nId);
    resetFlowConnection(makeId);
  });

  it('flows_explain_failure (a read): the error, the step and its type, the recent runs and our link', async () => {
    script = (n) => (n === 0 ? use(n, 'flows_explain_failure', { connection_id: n8nId, run_id: '104' }) : end('הסבר'));
    const m = await ask('למה הזרימה נכשלה?');
    expect(m.reads).toEqual(['flows_explain_failure']);
    expect(m.actions).toEqual([]);
    const out = toolResults().join('\n');
    expect(out).toContain('SMS provider said 401');
    expect(out).toContain('n8n-nodes-base.httpRequest');
    expect(out).toContain(`/a/acme/flows?connection=${n8nId}&flow=w1&run=104`);
    // Platform text reaches the model wrapped as untrusted content.
    expect(out).toMatch(/untrusted/i);
  });

  it('flows_get masks secrets in parameters', async () => {
    script = (n) => (n === 0 ? use(n, 'flows_get', { connection_id: n8nId, flow_id: 'w1' }) : end('ok'));
    await ask('מה יש בזרימה?');
    const out = toolResults().join('\n');
    expect(out).toContain('HTTP Request');
    expect(out).not.toContain('super-secret-value');
  });

  it('flows_update_draft: a card with the diff, nothing saved before approval; saved switched off', async () => {
    const edits = [
      {
        op: 'add_step',
        after: 'HTTP Request',
        step: { kind: 'bines', resource: 'update', operation: 'create', item_id: '={{ $json.item.id }}', text: 'נשלח' },
      },
      { op: 'rename_flow', name: 'Leads → SMS v2' },
    ];
    script = (n) =>
      n === 0 ? use(n, 'flows_update_draft', { connection_id: n8nId, flow_id: 'w1', edits }) : end('הצעתי שינוי');
    workflows[0]!.active = true;
    const m = await ask('הוסף עדכון אחרי השליחה');
    expect(m.actions).toHaveLength(1);
    const card = m.actions[0];
    expect(card).toMatchObject({ tool: 'flows_update_draft', status: 'pending' });
    expect(card.description.params).toMatchObject({ connection: 'n8n שלנו', flow: 'Leads → SMS' });
    const fields = card.description.details.map((d: Json) => d.field);
    expect(fields).toEqual(
      expect.arrayContaining(['flow_diff_flow_renamed', 'flow_diff_added', 'flow_diff_relinked', 'keep_active']),
    );
    expect(card.description.details.find((d: Json) => d.field === 'keep_active').value).toEqual({
      kind: 'bool',
      value: false,
    });
    expect(callsTo('PUT', /\/workflows\//)).toHaveLength(0);
    const done = await approve(m);
    expect(done.message.actions[0].status, JSON.stringify(done.message.actions[0])).toBe('done');
    // Switched off first, then saved: never live before a person switches it on.
    expect(callsTo('POST', /\/workflows\/w1\/deactivate$/)).toHaveLength(1);
    expect(callsTo('POST', /\/workflows\/w1\/activate$/)).toHaveLength(0);
    const sent = saved.at(-1)!;
    expect(sent.name).toBe('Leads → SMS v2');
    expect(sent.nodes.map((x: Json) => x.type)).toEqual([
      'n8n-nodes-base.webhook',
      'n8n-nodes-base.httpRequest',
      'n8n-nodes-bines-os.binesOs',
    ]);
    // The existing node is untouched (its credentials stay); only settings n8n accepts are sent.
    expect(sent.nodes[1].credentials).toEqual({ httpHeaderAuth: { id: 'c1', name: 'SMS key' } });
    expect(sent.settings).toEqual({ executionOrder: 'v1' });
    expect(workflows[0]!.active).toBe(false);
    expect((await auditOf('flow.updated')).at(-1)!.payload).toMatchObject({
      via: 'ai',
      active: false,
      was_active: true,
    });
  });

  it('keep_active only when asked: the flow stays on', async () => {
    workflows[0]!.active = true;
    script = (n) =>
      n === 0
        ? use(n, 'flows_update_draft', {
            connection_id: n8nId,
            flow_id: 'w1',
            edits: [{ op: 'rename_step', node: 'HTTP Request', name: 'Send SMS' }],
            keep_active: true,
          })
        : end('ok');
    const m = await ask('שנה שם לשלב והשאר את הזרימה דולקת');
    expect(m.actions[0].description.details.find((d: Json) => d.field === 'keep_active').value.value).toBe(true);
    await approve(m);
    expect(callsTo('POST', /\/workflows\/w1\/deactivate$/)).toHaveLength(0);
    expect(workflows[0]!.active).toBe(true);
    expect(saved.at(-1)!.connections['Send SMS']).toBeDefined();
  });

  it('an edit that does not fit the flow is answered to the model, never proposed', async () => {
    script = (n) =>
      n === 0
        ? use(n, 'flows_update_draft', {
            connection_id: n8nId,
            flow_id: 'w1',
            edits: [{ op: 'remove_step', node: 'Nope' }],
          })
        : end('ok');
    const m = await ask('מחק שלב');
    expect(m.actions).toEqual([]);
    expect(toolResults().join('\n')).toContain('flow_edit_node_not_found');
  });

  it('Make: editing is refused in plain words (no card, no write)', async () => {
    script = (n) =>
      n === 0
        ? use(n, 'flows_update_draft', {
            connection_id: makeId,
            flow_id: '9',
            edits: [{ op: 'rename_flow', name: 'x' }],
          })
        : end('ok');
    const m = await ask('שנה את השם');
    expect(m.actions).toEqual([]);
    const out = toolResults().join('\n');
    expect(out).toContain('flow_edit_not_supported');
    expect(out).toContain('only n8n flows can be edited');
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('flows_set_active and flows_rerun: approval cards; run only after approval; ai_operate switches them off', async () => {
    workflows[0]!.active = true;
    script = (n) =>
      n === 0
        ? {
            content: [
              ...use(n, 'flows_set_active', { connection_id: n8nId, flow_id: 'w1', active: false }).content,
              ...use(n, 'flows_rerun', { connection_id: n8nId, run_id: '104', flow_id: 'w1' }).content,
            ],
            stop: 'tool_use',
          }
        : end('ok');
    const m = await ask('כבה את הזרימה והרץ שוב');
    expect(m.actions.map((x: Json) => x.tool)).toEqual(['flows_set_active', 'flows_rerun']);
    expect(m.actions[0].description).toMatchObject({ variant: 'off', params: { flow: 'Leads → SMS v2' } });
    expect(callsTo('POST', /deactivate|retry/)).toHaveLength(0);
    const done = await approve(m);
    expect(
      done.message.actions.map((x: Json) => x.status),
      JSON.stringify(done.message.actions),
    ).toEqual(['done', 'done']);
    expect(callsTo('POST', /\/workflows\/w1\/deactivate$/)).toHaveLength(1);
    expect(callsTo('POST', /\/executions\/104\/retry$/)).toHaveLength(1);
    expect((await auditOf('flow.run_retried')).at(-1)!.payload).toMatchObject({ via: 'ai', run_id: '104' });
    // The connection's own setting: the AI may not operate here any more.
    await as(admin).patch(`/flow-connections/${n8nId}`, { settings: { ai_operate: false } });
    script = (n) =>
      n === 0 ? use(n, 'flows_set_active', { connection_id: n8nId, flow_id: 'w1', active: true }) : end('ok');
    const off = await ask('הדלק');
    expect(off.actions).toEqual([]);
    expect(toolResults().join('\n')).toContain('flow_ai_operate_off');
    await as(admin).patch(`/flow-connections/${n8nId}`, { settings: { ai_operate: true } });
  });

  it('an agent: the edit waits for approval, then runs; on Make the approved call answers "not supported"', async () => {
    const agent = await body(
      await as(admin).post('/agents', {
        name: 'מתחזק זרימות',
        instructions: 'Maintain flows.',
        connection_id: aiConnectionId,
        model: 'claude-opus-5-5',
        tools: ['flows_list', 'flows_update_draft'],
        boards: [{ board_id: boardId, level: 'view' }],
        approval_mode: 'autonomous',
      }),
    );
    script = (n) =>
      n === 0
        ? use(n, 'flows_update_draft', {
            connection_id: makeId,
            flow_id: '9',
            edits: [{ op: 'rename_flow', name: 'x' }],
          })
        : end('done');
    const run = await body(await as(admin).post(`/agents/${agent.id}/runs`, { prompt: 'rename it' }));
    expect(run.status).toBe('waiting_approval');
    const pending = await body(await as(admin).get('/agents/approvals?status=pending'));
    const ap = pending.data.find((x: Json) => x.run_id === run.id);
    expect(ap).toMatchObject({ tool: 'flows_update_draft' });
    expect((await as(admin).post(`/agents/approvals/${ap.id}`, { decision: 'approve' })).status).toBe(200);
    const d = await body(await as(admin).get(`/agents/runs/${run.id}`));
    const step = d.steps.find((s: Json) => s.kind === 'tool');
    expect(step.output).toMatchObject({ ok: false, supported: false, platform: 'make' });
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
});

describe('the connection keeps the AI switches', () => {
  it('ai_operate / ai_edit default on and are saved per connection', async () => {
    const row = (await t.db.select().from(flowConnections).where(eq(flowConnections.id, makeId)))[0]!;
    expect(row.platform).toBe('make');
    const list = await body(await as(admin).get('/flow-connections'));
    expect(list.data.find((c: Json) => c.id === makeId).settings).toMatchObject({ ai_operate: true, ai_edit: true });
    expect(list.data.find((c: Json) => c.id === makeId).caps).toMatchObject({ edit: false });
    const res = await as(admin).patch(`/flow-connections/${n8nId}`, { settings: { ai_edit: false } });
    expect((await body(res)).settings.ai_edit).toBe(false);
  });
});
