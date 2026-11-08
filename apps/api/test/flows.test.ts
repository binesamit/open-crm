// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import { newId } from '@bines/shared';
import { type AiClientFactory, type AnthropicLike, createAiClient } from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, flowConnections, flowFailureAlerts, notifications, users } from '../src/db/schema';
import type { FlowHttpRequest, FlowHttpResponse } from '../src/modules/flows/adapters/types';
import { checkFlowFailures, setFlowHttpForTests } from '../src/modules/flows/flows.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * "זרימות": connections to n8n / Make / Zapier (admins, sealed keys), the flows screen's API
 * (adapter mapping, on / off, runs, retry), failure alerts (deduped), the AI builder (approval, created switched off)
 * and who may see what. Every platform is a fake transport — no network.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let otherAdmin: string;
let acmeId: string;
let otherId: string;
let adminId: string;
let aiConnectionId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string, accountId = acmeId) => t.api(cookie, accountId);

// ---- the fake platforms ----
const N8N = 'https://n8n.acme.example';
const N8N_KEY = 'n8n-api-key-000000-abcd';
const MAKE_TOKEN = 'make-token-000000-efgh';
const ZAP_TOKEN = 'zapier-token-0000-ijkl';
const calls: FlowHttpRequest[] = [];
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

type Exec = { id: string; workflowId: string; status: string; startedAt: string; stoppedAt: string };
let workflows: Json[];
let executions: Exec[];
const created: Json[] = [];
/** Faults: Make scenarios whose logs answer 400; Make logs added per scenario; Zapier runs refused (scope). */
const makeLogsRefused = new Set<string>();
let makeExtraLogs: Record<string, Json[]> = {};
let zapRunsRefused = false;
/** Make's per-organization limit reached: every logs call answers 429. n8n's executions answering 400. */
let makeRateLimited = false;
let n8nExecRefused = false;
/** The second Make scenario switched on (an inactive scenario is left out of the account-wide failure walk). */
let makeSecondActive = false;

const reset = () => {
  makeLogsRefused.clear();
  makeExtraLogs = {};
  zapRunsRefused = false;
  makeRateLimited = false;
  n8nExecRefused = false;
  makeSecondActive = false;
  workflows = [
    { id: 'w1', name: 'Leads → SMS', active: true, updatedAt: ago(600), tags: [{ name: 'crm' }] },
    { id: 'w2', name: 'Weekly report', active: false, updatedAt: ago(900) },
  ];
  executions = [
    { id: '103', workflowId: 'w1', status: 'error', startedAt: ago(5), stoppedAt: ago(4) },
    { id: '102', workflowId: 'w1', status: 'success', startedAt: ago(30), stoppedAt: ago(29) },
    { id: '101', workflowId: 'w2', status: 'success', startedAt: ago(60), stoppedAt: ago(59) },
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
  if (req.method === 'POST' && p === '/workflows') {
    const sent = JSON.parse(req.body!) as Json;
    created.push(sent);
    return reply(200, { ...sent, id: `w${10 + created.length}`, active: false });
  }
  const toggle = /^\/workflows\/([^/]+)\/(activate|deactivate)$/.exec(p);
  if (toggle && req.method === 'POST') {
    const wf = workflows.find((w) => w.id === toggle[1]);
    if (!wf) return reply(404, { message: 'not found' });
    wf.active = toggle[2] === 'activate';
    return reply(200, wf);
  }
  const one = /^\/workflows\/([^/]+)$/.exec(p);
  if (one) {
    const wf = workflows.find((w) => w.id === one[1]);
    return wf ? reply(200, wf) : reply(404, { message: 'not found' });
  }
  if (p === '/executions' && n8nExecRefused)
    return reply(400, { message: 'request/query/status must be equal to one of the allowed values' });
  if (p === '/executions') {
    const status = url.searchParams.get('status');
    const wf = url.searchParams.get('workflowId');
    return reply(200, {
      data: executions.filter((e) => (!status || e.status === status) && (!wf || e.workflowId === wf)),
      nextCursor: null,
    });
  }
  const retry = /^\/executions\/([^/]+)\/retry$/.exec(p);
  if (retry && req.method === 'POST') return reply(200, { id: '200' });
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
  if (p === '/scenarios') {
    expect(url.searchParams.get('teamId')).toBe('77');
    return reply(200, {
      scenarios: [
        { id: 9, name: 'Invoices', isActive: true, isPaused: false, lastEdit: ago(100) },
        { id: 8, name: 'Broken one', isActive: makeSecondActive, isinvalid: true },
      ],
    });
  }
  const logs = /^\/scenarios\/(\d+)\/logs$/.exec(p);
  if (logs) {
    if (makeRateLimited)
      return reply(429, { message: 'Requests limit for organization exceeded, please try again later.' });
    if (makeLogsRefused.has(logs[1]!))
      return reply(400, {
        detail: 'Invalid pagination parameter',
        message: 'Validation failed',
        code: 'IM005',
        suberrors: [{ message: 'pg[sortDir] is not allowed here' }],
      });
    const rows = [
      ...(makeExtraLogs[logs[1]!] ?? []),
      ...(logs[1] === '9'
        ? [
            { id: 'e2', status: 3, timestamp: ago(3), duration: 1200, error: { message: 'Quota exceeded' } },
            { id: 'e1', status: 1, timestamp: ago(20), duration: 800 },
            // An edit of the scenario sits in the same log: never a run.
            { id: '70772337', type: 'modify', timestamp: ago(30), detail: { author: { name: 'Dana' } } },
          ]
        : []),
    ];
    const status = url.searchParams.get('status');
    return reply(200, { scenarioLogs: rows.filter((r) => !status || String(r.status) === status) });
  }
  const start = /^\/scenarios\/(\d+)\/(start|stop)$/.exec(p);
  if (start) return reply(200, { scenario: { id: Number(start[1]), isActive: start[2] === 'start' } });
  const one = /^\/scenarios\/(\d+)$/.exec(p);
  if (one) return reply(200, { scenario: { id: Number(one[1]), name: 'Invoices', isActive: true } });
  return reply(404, { message: 'no route' });
};

const zapier = (req: FlowHttpRequest, url: URL): FlowHttpResponse => {
  if (req.headers.authorization !== `Bearer ${ZAP_TOKEN}`) return reply(401, { message: 'bad token' });
  if (url.pathname === '/v2/zaps')
    return reply(200, {
      data: [{ id: 'z1', title: 'Gmail → Sheet', is_enabled: true, links: { html_editor: 'https://zapier.com/e/z1' } }],
      links: { next: null },
    });
  if (url.pathname === '/v2/zap-runs' && zapRunsRefused)
    return reply(403, { message: 'The token is missing the scope zap:runs' });
  if (url.pathname === '/v2/zap-runs')
    return reply(200, {
      data: [
        {
          id: 'r1',
          zap_id: 'z1',
          status: url.searchParams.get('statuses') === 'error' ? 'error' : 'error',
          start_time: ago(2),
          end_time: ago(1),
          zap_title: 'Gmail → Sheet',
          steps: [{ status: 'error', title: 'Add row', error: 'Sheet not found' }],
        },
      ],
    });
  return reply(404, {});
};

const fakeHttp = async (req: FlowHttpRequest): Promise<FlowHttpResponse> => {
  calls.push(req);
  const url = new URL(req.url);
  if (url.origin === N8N) return n8n(req, url);
  if (url.hostname === 'eu1.make.com') return make(req, url);
  if (url.hostname === 'api.zapier.com') return zapier(req, url);
  throw new Error(`unexpected call ${req.url}`);
};

// ---- the mocked model ----
type Turn = { content: Anthropic.ContentBlock[]; stop: string };
let script: (n: number) => Turn = () => end('ok');
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

const DRAFT = {
  name: 'ליד חדש → עדכון',
  trigger: { kind: 'bines_event', event: 'item_created' },
  steps: [{ kind: 'bines', resource: 'update', operation: 'create', item_id: '={{ $json.item.id }}', text: 'שלום' }],
};

beforeAll(async () => {
  setFlowHttpForTests(fakeHttp);
  t = await createTestContext({ aiClient });
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'admin@other.test');
  const join = async (email: string) => {
    const token = t.inviteTokenFor(email);
    const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
    await t.api(cookie).post('/invitations/accept', { token });
    return cookie;
  };
  admin = await join('admin@acme.test');
  otherAdmin = await join('admin@other.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  adminId = (await t.db.select().from(users).where(eq(users.email, 'admin@acme.test')))[0]!.id;
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
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
});
afterAll(async () => {
  setFlowHttpForTests(null);
  await t.close();
});
beforeEach(() => {
  reset();
  calls.length = 0;
  script = () => end('ok');
});

let n8nId: string;
const auditOf = (action: string) => t.db.select().from(auditLog).where(eq(auditLog.action, action));

describe('connections (admins, sealed keys, test on save)', () => {
  it('an admin connects n8n: tested, the key never comes back and is sealed at rest', async () => {
    const res = await as(admin).post('/flow-connections', {
      name: 'n8n שלנו',
      target: { platform: 'n8n', base_url: `${N8N}/`, api_key: N8N_KEY },
    });
    const json = await body(res);
    expect(res.status, JSON.stringify(json)).toBe(201);
    n8nId = json.id;
    expect(json).toMatchObject({
      platform: 'n8n',
      base_url: N8N,
      secret_hint: '…abcd',
      status: 'ok',
      caps: { toggle: true, retry: true, create: true },
      can_manage: true,
      settings: { visibility: 'admins', alert_on_failure: true, alert_channel: 'bell' },
    });
    expect(JSON.stringify(json)).not.toContain(N8N_KEY);
    expect(JSON.stringify(await body(await as(admin).get('/flow-connections')))).not.toContain(N8N_KEY);
    const row = (await t.db.select().from(flowConnections).where(eq(flowConnections.id, n8nId)))[0]!;
    expect(row.secretEnc).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(N8N_KEY);
    expect(calls.some((c) => c.headers['X-N8N-API-KEY'] === N8N_KEY)).toBe(true);
    expect((await auditOf('flow_connection.created')).length).toBe(1);
  });

  it('a wrong key is saved with an error status the admin can read', async () => {
    const json = await body(
      await as(admin).post('/flow-connections', {
        name: 'bad',
        target: { platform: 'n8n', base_url: N8N, api_key: 'wrong-key-000000' },
      }),
    );
    expect(json.status).toBe('error');
    expect(json.last_error).toMatch(/flow_platform_unauthorized/);
    expect((await as(admin).del(`/flow-connections/${json.id}`)).status).toBe(200);
    const row = (await t.db.select().from(flowConnections).where(eq(flowConnections.id, json.id)))[0]!;
    expect(row.deletedAt).toBeTruthy();
    expect(row.secretEnc).toBeNull();
  });

  it('settings change by admins only; recipients must belong to the account', async () => {
    const res = await as(admin).patch(`/flow-connections/${n8nId}`, { settings: { check_every_minutes: 30 } });
    expect((await body(res)).settings.check_every_minutes).toBe(30);
    const bad = await as(admin).patch(`/flow-connections/${n8nId}`, { settings: { alert_recipients: [newId()] } });
    expect(bad.status).toBe(422);
    expect((await as(bob).patch(`/flow-connections/${n8nId}`, { name: 'x' })).status).toBe(403);
    expect(
      (
        await as(bob).post('/flow-connections', {
          name: 'x',
          target: { platform: 'n8n', base_url: N8N, api_key: N8N_KEY },
        })
      ).status,
    ).toBe(403);
  });

  it('never with an API token; another account sees nothing', async () => {
    const created = await body(await as(admin).post('/auth/tokens', { name: 'all', scopes: ['admin'] }));
    const res = await t.app.request('/api/v1/flow-connections', {
      headers: { authorization: `Bearer ${created.token}`, 'x-account-id': acmeId },
    });
    expect(res.status).toBe(403);
    expect((await body(await as(otherAdmin, otherId).get('/flow-connections'))).data).toEqual([]);
    expect((await as(otherAdmin, otherId).get(`/flow-connections/${n8nId}/flows`)).status).toBe(404);
  });

  it('the platform owner decides which platforms accounts may connect', async () => {
    expect((await t.api(owner).patch('/platform/settings', { flows: { platforms: ['n8n', 'make'] } })).status).toBe(
      200,
    );
    const res = await as(admin).post('/flow-connections', {
      name: 'zap',
      target: { platform: 'zapier', access_token: ZAP_TOKEN },
    });
    expect(res.status).toBe(403);
    expect((await body(await as(admin).get('/flow-connections'))).platforms).toEqual(['n8n', 'make']);
    await t.api(owner).patch('/platform/settings', { flows: { platforms: ['n8n', 'make', 'zapier'] } });
  });
});

describe('the flows screen: n8n', () => {
  it('lists flows with status, last run and failures of the week', async () => {
    const { data } = await body(await as(admin).get(`/flow-connections/${n8nId}/flows`));
    expect(data).toEqual([
      expect.objectContaining({
        id: 'w1',
        name: 'Leads → SMS',
        active: true,
        status: 'error',
        last_run_status: 'error',
        errors_7d: 1,
        open_url: `${N8N}/workflow/w1`,
        tags: ['crm'],
      }),
      expect.objectContaining({
        id: 'w2',
        active: false,
        status: 'inactive',
        last_run_status: 'success',
        errors_7d: 0,
      }),
    ]);
  });

  it('runs: failed ones with the error and the node; retry; on / off — all audited', async () => {
    const runs = await body(await as(admin).get(`/flow-connections/${n8nId}/runs?flow_id=w1&status=error`));
    expect(runs.data.map((r: Json) => [r.id, r.status, r.can_retry])).toEqual([
      ['103', 'error', true],
      ['50', 'error', true],
    ]);
    const run = await body(await as(admin).get(`/flow-connections/${n8nId}/runs/103`));
    expect(run).toMatchObject({ status: 'error', error: 'SMS provider said 401', error_node: 'HTTP Request' });
    expect(run.duration_ms).toBe(60_000);
    expect(await body(await as(admin).post(`/flow-connections/${n8nId}/runs/103/retry`, {}))).toEqual({
      run_id: '200',
    });
    const off = await body(await as(admin).put(`/flow-connections/${n8nId}/flows/w1/active`, { active: false }));
    expect(off).toMatchObject({ id: 'w1', active: false });
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/workflows/w1/deactivate'))).toBe(true);
    expect((await auditOf('flow.deactivated')).length).toBe(1);
    expect((await auditOf('flow.run_retried')).length).toBe(1);
  });

  it('members: nothing until an admin opens the connection to them — then read only', async () => {
    expect((await body(await as(bob).get('/flow-connections'))).data).toEqual([]);
    expect((await as(bob).get(`/flow-connections/${n8nId}/flows`)).status).toBe(404);
    await as(admin).patch(`/flow-connections/${n8nId}`, { settings: { visibility: 'members' } });
    const list = await body(await as(bob).get('/flow-connections'));
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ id: n8nId, secret_hint: null, settings: null, can_manage: false });
    expect((await as(bob).get(`/flow-connections/${n8nId}/flows`)).status).toBe(200);
    expect((await as(bob).put(`/flow-connections/${n8nId}/flows/w1/active`, { active: true })).status).toBe(403);
    expect((await as(bob).post(`/flow-connections/${n8nId}/runs/103/retry`, {})).status).toBe(403);
    expect((await as(bob).post(`/flow-connections/${n8nId}/flows`, { draft: DRAFT })).status).toBe(403);
    await as(admin).patch(`/flow-connections/${n8nId}`, { settings: { visibility: 'admins' } });
  });
});

describe('Make and Zapier behind the same interface', () => {
  it('Make: scenarios, logs (3 = error), start / stop; no drafts yet', async () => {
    const c = await body(
      await as(admin).post('/flow-connections', {
        name: 'Make',
        target: { platform: 'make', zone: 'eu1', team_id: 77, api_token: MAKE_TOKEN },
      }),
    );
    expect(c).toMatchObject({ status: 'ok', base_url: 'https://eu1.make.com', zone: 'eu1', team_id: 77 });
    // The list is one call; an active scenario's stats come on their own (Make's per-minute limit).
    calls.length = 0;
    const { data } = await body(await as(admin).get(`/flow-connections/${c.id}/flows`));
    expect(calls.map((x) => new URL(x.url).pathname)).toEqual(['/api/v2/scenarios']);
    expect(data[0]).toMatchObject({ id: '9', status: 'active', errors_7d: null, stats_pending: true });
    expect(data[0].open_url).toBe('https://eu1.make.com/77/scenarios/9/edit');
    expect(data[1]).toMatchObject({ id: '8', status: 'error', active: false });
    expect(data[1].stats_pending).toBeUndefined();
    const stats = await body(await as(admin).post(`/flow-connections/${c.id}/flows/stats`, { flow_ids: ['9'] }));
    expect(stats).toMatchObject({ pending: [], limited: null });
    expect(stats.data['9']).toMatchObject({ status: 'error', errors_7d: 1, last_run_status: 'error' });
    // Kept: the list now carries them, without asking Make again.
    calls.length = 0;
    const again = await body(await as(admin).get(`/flow-connections/${c.id}/flows`));
    expect(calls).toHaveLength(0);
    expect(again.data[0]).toMatchObject({ id: '9', status: 'error', errors_7d: 1, last_run_status: 'error' });
    expect(again.data[0].stats_pending).toBeUndefined();
    const runs = await body(await as(admin).get(`/flow-connections/${c.id}/runs?flow_id=9&status=error`));
    expect(runs.data[0]).toMatchObject({ id: 'e2', status: 'error', error: 'Quota exceeded', duration_ms: 1200 });
    expect((await as(admin).put(`/flow-connections/${c.id}/flows/9/active`, { active: false })).status).toBe(200);
    expect(calls.some((x) => x.url.endsWith('/scenarios/9/stop'))).toBe(true);
    const draft = await as(admin).post(`/flow-connections/${c.id}/flows`, { draft: DRAFT });
    expect(draft.status).toBe(422);
    expect((await body(draft)).error.message).toBe('flow_not_supported');
  });

  it('Zapier: monitoring only', async () => {
    const c = await body(
      await as(admin).post('/flow-connections', {
        name: 'Zapier',
        target: { platform: 'zapier', access_token: ZAP_TOKEN },
      }),
    );
    expect(c.caps).toEqual({ toggle: false, retry: false, create: false, edit: false });
    const { data } = await body(await as(admin).get(`/flow-connections/${c.id}/flows`));
    expect(data[0]).toMatchObject({ id: 'z1', active: true, status: 'error', errors_7d: 1 });
    const runs = await body(await as(admin).get(`/flow-connections/${c.id}/runs?status=error`));
    expect(runs.data[0]).toMatchObject({ status: 'error', error: 'Sheet not found', error_node: 'Add row' });
    expect((await as(admin).put(`/flow-connections/${c.id}/flows/z1/active`, { active: false })).status).toBe(422);
    expect((await as(admin).post(`/flow-connections/${c.id}/runs/r1/retry`, {})).status).toBe(422);
    await as(admin).del(`/flow-connections/${c.id}`);
  });
});

describe('failure alerts (deduped)', () => {
  it('a new failure reaches the admins once; history before connecting never', async () => {
    // Only the n8n connection alerts here.
    for (const row of await t.db.select().from(flowConnections).where(eq(flowConnections.accountId, acmeId)))
      if (row.id !== n8nId)
        await as(admin).patch(`/flow-connections/${row.id}`, { settings: { alert_on_failure: false } });
    const mine = () =>
      t.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, adminId), eq(notifications.type, 'flow_failed')));
    const now = new Date();
    // Everything so far happened before the connection was made: history, no alert.
    expect(await checkFlowFailures(t.deps, now)).toBe(0);
    expect(await mine()).toHaveLength(0);
    // A new failure after connecting.
    const fail = (id: string, workflowId: string) =>
      executions.unshift({
        id,
        workflowId,
        status: 'error',
        startedAt: new Date().toISOString(),
        stoppedAt: new Date().toISOString(),
      });
    fail('104', 'w1');
    expect(await checkFlowFailures(t.deps, new Date(now.getTime() + 31 * 60_000))).toBe(1);
    const first = await mine();
    expect(first).toHaveLength(1);
    // The run is read for its error (n8n lists runs without it): the alert says why.
    expect(first[0]!.payload).toMatchObject({
      excerpt: 'Leads → SMS: SMS provider said 401',
      flow: { connection_id: n8nId, flow_id: 'w1', run_id: '104', count: 1 },
    });
    // Bell only (the default): the email queue treats it as sent.
    expect(first[0]!.emailedAt).toBeTruthy();
    // Within the interval: not asked at all. After it: asked, but nothing new.
    const before = calls.length;
    expect(await checkFlowFailures(t.deps, new Date(now.getTime() + 32 * 60_000))).toBe(0);
    expect(calls.length).toBe(before);
    expect(await checkFlowFailures(t.deps, new Date(now.getTime() + 62 * 60_000))).toBe(0);
    expect(await mine()).toHaveLength(1);
    // Another new failure: one more alert.
    fail('105', 'w2');
    expect(await checkFlowFailures(t.deps, new Date(now.getTime() + 93 * 60_000))).toBe(1);
    expect(await mine()).toHaveLength(2);
    expect(
      (await t.db.select().from(flowFailureAlerts).where(eq(flowFailureAlerts.connectionId, n8nId)))
        .map((r) => r.runId)
        .sort(),
    ).toEqual(['104', '105']);
    // A member never hears it unless named.
    const bobId = (await t.db.select().from(users).where(eq(users.email, 'bob@acme.test')))[0]!.id;
    expect(
      await t.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, bobId), eq(notifications.type, 'flow_failed'))),
    ).toHaveLength(0);
  });
});

describe('the AI builder: a draft, a person approves, created switched off', () => {
  it('the dialog: words → a draft (nothing created) → the admin creates it, off', async () => {
    await as(admin).patch(`/flow-connections/${n8nId}`, { settings: { ai_connection_id: aiConnectionId } });
    script = () => ({
      content: [
        { type: 'text', text: 'Connect the Bines OS credential in n8n.', citations: null } as Anthropic.TextBlock,
        { type: 'tool_use', id: 'tu_1', name: 'submit_flow_draft', input: DRAFT } as Anthropic.ToolUseBlock,
      ],
      stop: 'tool_use',
    });
    const res = await as(admin).post(`/flow-connections/${n8nId}/drafts`, { request: 'כשנכנס ליד, כתוב עדכון' });
    const draft = await body(res);
    expect(res.status, JSON.stringify(draft)).toBe(200);
    expect(draft.lines.map((l: Json) => l.key)).toEqual(['flows.draft.trigger.bines_event', 'flows.draft.step.bines']);
    expect(draft.notes).toContain('credential');
    expect(created).toHaveLength(0);
    const flow = await body(await as(admin).post(`/flow-connections/${n8nId}/flows`, { draft: draft.draft }));
    expect(flow).toMatchObject({ active: false, status: 'inactive', name: 'ליד חדש → עדכון' });
    const sent = created.at(-1)!;
    expect(sent.nodes.map((n: Json) => n.type)).toEqual([
      'n8n-nodes-bines-os.binesOsTrigger',
      'n8n-nodes-bines-os.binesOs',
    ]);
    expect(sent).not.toHaveProperty('active');
    expect((await auditOf('flow.created')).at(-1)!.payload).toMatchObject({ via: 'person', active: false });
  });

  it('an agent: flows_draft_create always waits for approval, then creates the flow switched off', async () => {
    const agent = await body(
      await as(admin).post('/agents', {
        name: 'בונה זרימות',
        instructions: 'Build flows.',
        connection_id: aiConnectionId,
        model: 'claude-opus-5-5',
        tools: ['flows_list', 'flows_draft_create'],
        boards: [{ board_id: boardId, level: 'view' }],
        approval_mode: 'autonomous',
      }),
    );
    expect(agent.id).toBeTruthy();
    script = (n) => (n === 0 ? use(n, 'flows_draft_create', { connection_id: n8nId, draft: DRAFT }) : end('done'));
    const before = created.length;
    const run = await body(await as(admin).post(`/agents/${agent.id}/runs`, { prompt: 'build it' }));
    expect(run.status).toBe('waiting_approval');
    expect(created.length).toBe(before);
    const pending = await body(await as(admin).get('/agents/approvals?status=pending'));
    const ap = pending.data.find((x: Json) => x.run_id === run.id);
    expect(ap).toMatchObject({ tool: 'flows_draft_create' });
    expect((await as(admin).post(`/agents/approvals/${ap.id}`, { decision: 'approve' })).status).toBe(200);
    const d = await body(await as(admin).get(`/agents/runs/${run.id}`));
    const step = d.steps.find((s: Json) => s.kind === 'tool');
    expect(step.outcome, JSON.stringify(step.output)).toBe('ran');
    expect(created.length).toBe(before + 1);
    expect((await auditOf('flow.created')).at(-1)!.payload).toMatchObject({ via: 'ai', active: false });
  });

  it('AI creation can be switched off per connection', async () => {
    await as(admin).patch(`/flow-connections/${n8nId}`, { settings: { ai_create: false } });
    const res = await as(admin).post(`/flow-connections/${n8nId}/drafts`, { request: 'anything at all' });
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('flow_ai_create_off');
    await as(admin).patch(`/flow-connections/${n8nId}`, { settings: { ai_create: true } });
  });
});

describe('one flow failing never fails the list (Make logs 400 → 502)', () => {
  const connect = async (target: Json, name: string) =>
    body(await as(admin).post('/flow-connections', { name, target }));
  const makeTarget = { platform: 'make', zone: 'eu1', team_id: 77, api_token: MAKE_TOKEN };
  const logCalls = () => calls.map((c) => new URL(c.url)).filter((u) => /\/scenarios\/\d+\/logs$/.test(u.pathname));

  it('Make: logs are asked with documented params only (no sort, small pages, from/to in ms)', async () => {
    const c = await connect(makeTarget, 'Make params');
    calls.length = 0;
    expect((await as(admin).get(`/flow-connections/${c.id}/flows`)).status).toBe(200);
    expect(logCalls()).toHaveLength(0);
    expect((await as(admin).post(`/flow-connections/${c.id}/flows/stats`, { flow_ids: ['9'] })).status).toBe(200);
    const urls = logCalls();
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect([...u.searchParams.keys()].every((k) => ['pg[limit]', 'status', 'from', 'to'].includes(k))).toBe(true);
      expect(Number(u.searchParams.get('pg[limit]'))).toBeGreaterThanOrEqual(1);
      expect(Number(u.searchParams.get('pg[limit]'))).toBeLessThanOrEqual(50);
    }
    const failed = urls.find((u) => u.searchParams.get('status') === '3')!;
    const from = Number(failed.searchParams.get('from'));
    const to = Number(failed.searchParams.get('to'));
    expect(Number.isInteger(from) && Number.isInteger(to)).toBe(true);
    expect(to - from).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 60_000);
    expect(Math.abs(to - Date.now())).toBeLessThan(60_000);
    await as(admin).del(`/flow-connections/${c.id}`);
  });

  it("Make: a scenario's logs answering 400 → the list still answers; that flow carries a warning + Make's reason", async () => {
    const c = await connect(makeTarget, 'Make 400');
    makeLogsRefused.add('9');
    const listed = await as(admin).get(`/flow-connections/${c.id}/flows`);
    expect(listed.status).toBe(200);
    expect((await body(listed)).data).toHaveLength(2);
    const res = await as(admin).post(`/flow-connections/${c.id}/flows/stats`, { flow_ids: ['9', '8'] });
    expect(res.status).toBe(200);
    const answer0 = await body(res);
    expect(answer0.pending).toEqual([]);
    const data = [answer0.data['9'], answer0.data['8']];
    expect(data[0]).toMatchObject({
      last_run_at: null,
      last_run_status: null,
      errors_7d: null,
      warning: 'flow_stats_unavailable',
    });
    expect(data[0].warning_detail).toContain('400');
    expect(data[0].warning_detail).toContain('Invalid pagination parameter');
    expect(data[0].warning_detail).toContain('IM005');
    // The other scenario is untouched.
    expect(data[1]).toMatchObject({ errors_7d: 0 });
    expect(data[1].warning ?? null).toBeNull();
    // Runs of all scenarios skip the refused one; asking for it alone says why.
    expect((await as(admin).get(`/flow-connections/${c.id}/runs?status=error`)).status).toBe(200);
    const one = await as(admin).get(`/flow-connections/${c.id}/runs?flow_id=9`);
    expect(one.status).toBe(200);
    const answer = await body(one);
    expect(answer).toMatchObject({ data: [], warning: 'flow_runs_unavailable' });
    expect(answer.warning_detail).toContain('Invalid pagination parameter');
    await as(admin).del(`/flow-connections/${c.id}`);
  });

  it('the connection test: connected, but the run history is refused → ok with a warning (the reason)', async () => {
    makeLogsRefused.add('9');
    const c = await connect(makeTarget, 'Make test');
    expect(c).toMatchObject({ status: 'ok', last_error: null });
    expect(c.warning).toContain('Invalid pagination parameter');
    // Fixed on Make's side: the next test clears the warning.
    makeLogsRefused.clear();
    expect(await body(await as(admin).post(`/flow-connections/${c.id}/test`, {}))).toMatchObject({
      status: 'ok',
      warning: null,
    });
    await as(admin).del(`/flow-connections/${c.id}`);
  });

  it('Zapier without the runs scope: connected with a warning; the list answers with null stats', async () => {
    zapRunsRefused = true;
    const c = await connect({ platform: 'zapier', access_token: ZAP_TOKEN }, 'Zapier scope');
    expect(c).toMatchObject({ status: 'ok', last_error: null });
    expect(c.warning).toContain('zap:runs');
    const res = await as(admin).get(`/flow-connections/${c.id}/flows`);
    expect(res.status).toBe(200);
    expect((await body(res)).data[0]).toMatchObject({ id: 'z1', errors_7d: null, warning: 'flow_stats_unavailable' });
    await as(admin).del(`/flow-connections/${c.id}`);
  });

  it('n8n: executions failing leave the workflows listed with a warning', async () => {
    const c = await connect({ platform: 'n8n', base_url: N8N, api_key: N8N_KEY }, 'n8n stats');
    const real = executions;
    executions = new Proxy(real, {
      get: (target, key) => {
        if (key === 'filter') throw new Error('boom');
        return Reflect.get(target, key) as unknown;
      },
    });
    try {
      const res = await as(admin).get(`/flow-connections/${c.id}/flows`);
      expect(res.status).toBe(200);
      const { data } = await body(res);
      expect(data.map((f: Json) => f.id)).toEqual(['w1', 'w2']);
      expect(data[0]).toMatchObject({ errors_7d: null, warning: 'flow_stats_unavailable' });
    } finally {
      executions = real;
    }
    await as(admin).del(`/flow-connections/${c.id}`);
  });

  it("the alerts job: one scenario's refused logs skip only that scenario; the others still alert", async () => {
    for (const row of await t.db.select().from(flowConnections).where(eq(flowConnections.accountId, acmeId)))
      await as(admin).patch(`/flow-connections/${row.id}`, { settings: { alert_on_failure: false } });
    makeSecondActive = true;
    const c = await connect(makeTarget, 'Make alerts');
    await as(admin).patch(`/flow-connections/${c.id}`, { settings: { alert_on_failure: true } });
    makeLogsRefused.add('9');
    makeExtraLogs['8'] = [
      {
        id: 'e8',
        status: 3,
        timestamp: new Date(Date.now() + 1000).toISOString(),
        duration: 10,
        error: { message: 'Broken module' },
      },
    ];
    expect(await checkFlowFailures(t.deps, new Date(Date.now() + 60_000))).toBe(1);
    const alerts = await t.db.select().from(flowFailureAlerts).where(eq(flowFailureAlerts.connectionId, c.id));
    expect(alerts.map((a) => a.runId)).toEqual(['e8']);
    // One scenario's trouble is not the connection's.
    const row = (await t.db.select().from(flowConnections).where(eq(flowConnections.id, c.id)))[0]!;
    expect(row.status).toBe('ok');
    await as(admin).del(`/flow-connections/${c.id}`);
  });
});

describe("one flow's runs: a warning, never a 502 (Make 429 on the drawer → 502)", () => {
  const connect = async (target: Json, name: string) =>
    body(await as(admin).post('/flow-connections', { name, target }));
  const makeTarget = { platform: 'make', zone: 'eu1', team_id: 77, api_token: MAKE_TOKEN };
  const makeCalls = () => calls.map((c) => new URL(c.url)).filter((u) => u.hostname === 'eu1.make.com');
  const logsCalls = () => makeCalls().filter((u) => u.pathname.endsWith('/logs'));

  it('Make, one scenario: exactly GET /scenarios/{id}/logs?pg[limit]=N (+ status=3 for "error"), nothing else', async () => {
    const c = await connect(makeTarget, 'Make one');
    calls.length = 0;
    const all = await body(await as(admin).get(`/flow-connections/${c.id}/runs?status=all&limit=50&flow_id=9`));
    expect(all.warning).toBeUndefined();
    // The scenario's edit ("modify") is not a run.
    expect(all.data.map((r: Json) => r.id)).toEqual(['e2', 'e1']);
    let urls = makeCalls();
    expect(urls.map((u) => u.pathname)).toEqual(['/api/v2/scenarios/9/logs']);
    expect([...urls[0]!.searchParams.entries()]).toEqual([['pg[limit]', '50']]);

    calls.length = 0;
    const failed = await body(await as(admin).get(`/flow-connections/${c.id}/runs?status=error&limit=50&flow_id=9`));
    expect(failed.data.map((r: Json) => r.id)).toEqual(['e2']);
    urls = makeCalls();
    expect(urls.map((u) => u.pathname)).toEqual(['/api/v2/scenarios/9/logs']);
    expect([...urls[0]!.searchParams.entries()]).toEqual([
      ['pg[limit]', '50'],
      ['status', '3'],
    ]);
    await as(admin).del(`/flow-connections/${c.id}`);
  });

  it("Make 400 on one scenario's logs → 200, no runs, a warning with Make's own message", async () => {
    const c = await connect(makeTarget, 'Make one 400');
    makeLogsRefused.add('9');
    for (const status of ['all', 'error']) {
      const res = await as(admin).get(`/flow-connections/${c.id}/runs?status=${status}&limit=50&flow_id=9`);
      expect(res.status).toBe(200);
      const answer = await body(res);
      expect(answer).toMatchObject({ data: [], warning: 'flow_runs_unavailable' });
      expect(answer.warning_detail).toContain('(400)');
      expect(answer.warning_detail).toContain('Validation failed');
      expect(answer.warning_detail).toContain('IM005');
    }
    await as(admin).del(`/flow-connections/${c.id}`);
  });

  it("Make's per-organization limit (429): the stats stop at the first 429; nothing calls Make until the reset", async () => {
    const c = await connect(makeTarget, 'Make 429');
    makeRateLimited = true;
    calls.length = 0;
    const list = await as(admin).get(`/flow-connections/${c.id}/flows`);
    expect(list.status).toBe(200);
    expect((await body(list)).data.map((f: Json) => f.id)).toEqual(['9', '8']);
    const stats = await body(await as(admin).post(`/flow-connections/${c.id}/flows/stats`, { flow_ids: ['9', '8'] }));
    expect(stats.pending).toEqual(['9', '8']);
    expect(stats.limited).toMatchObject({ by: 'platform' });
    expect(stats.limited.reason).toContain('Requests limit for organization exceeded');
    // One logs call, not two per scenario: the rest of the pass would only add to the limit.
    expect(logsCalls()).toHaveLength(1);

    // The drawer: no call during the backoff; a warning with Make's reason and when it asks again.
    calls.length = 0;
    const one = await as(admin).get(`/flow-connections/${c.id}/runs?status=all&limit=50&flow_id=6976041`);
    expect(one.status).toBe(200);
    const answer = await body(one);
    expect(answer).toMatchObject({ data: [], warning: 'flow_platform_limited', limited: { by: 'platform' } });
    expect(answer.warning_detail).toContain('(429)');
    expect(answer.warning_detail).toContain('Requests limit for organization exceeded');
    // Runs of all scenarios (the failure check's pass) wait as well.
    expect((await as(admin).get(`/flow-connections/${c.id}/runs?status=error`)).status).toBe(200);
    expect(makeCalls()).toHaveLength(0);
    await as(admin).del(`/flow-connections/${c.id}`);
  });

  it('a refused key (401) stays an error: the connection itself is broken', async () => {
    const c = await connect({ ...makeTarget, api_token: 'make-token-wrong-0000' }, 'Make bad key');
    expect(c.status).toBe('error');
    const res = await as(admin).get(`/flow-connections/${c.id}/runs?status=all&limit=50&flow_id=9`);
    expect(res.status).toBe(502);
    expect((await body(res)).error.message).toBe('flow_platform_unauthorized');
    await as(admin).del(`/flow-connections/${c.id}`);
  });

  it('n8n and Zapier, one flow: the same — a warning with the platform reason, HTTP 200', async () => {
    const n = await connect({ platform: 'n8n', base_url: N8N, api_key: N8N_KEY }, 'n8n one');
    n8nExecRefused = true;
    const nRes = await as(admin).get(`/flow-connections/${n.id}/runs?status=error&limit=50&flow_id=w1`);
    expect(nRes.status).toBe(200);
    const nAnswer = await body(nRes);
    expect(nAnswer).toMatchObject({ data: [], warning: 'flow_runs_unavailable' });
    expect(nAnswer.warning_detail).toContain('must be equal to one of the allowed values');
    // All runs of the connection: one call for everything, so its error is still the answer.
    expect((await as(admin).get(`/flow-connections/${n.id}/runs?status=error`)).status).toBe(502);
    await as(admin).del(`/flow-connections/${n.id}`);

    // Zapier's 403 is a missing scope (what the key may read), not a broken key.
    zapRunsRefused = true;
    const z = await connect({ platform: 'zapier', access_token: ZAP_TOKEN }, 'Zapier one');
    const zRes = await as(admin).get(`/flow-connections/${z.id}/runs?status=all&limit=50&flow_id=z1`);
    expect(zRes.status).toBe(200);
    const zAnswer = await body(zRes);
    expect(zAnswer).toMatchObject({ data: [], warning: 'flow_runs_unavailable' });
    expect(zAnswer.warning_detail).toContain('zap:runs');
    await as(admin).del(`/flow-connections/${z.id}`);
  });
});
