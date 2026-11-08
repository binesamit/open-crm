// SPDX-License-Identifier: AGPL-3.0-only
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Dashboard widgets for AI: list_dashboards / get_dashboard read, add / update / remove a widget
 * through the dashboard service — the same permissions (an editor of the dashboard), validation, one undoable batch
 * per call, and the `dashboards` plan feature like the dashboard routes.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let wsId: string;
let leadsId: string;
let dashId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const mint = async (cookie: string, scopes: string[]) =>
  (await body(await t.api(cookie, acmeId).post('/auth/tokens', { name: 'Claude Code', scopes }))).token as string;
const fetchApp = (url: string | URL | Request, init?: RequestInit) =>
  t.app.request(url instanceof Request ? url : String(url), init) as Promise<Response>;
const connect = async (token: string) => {
  const client = new Client({ name: 'bines-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${WEB_ORIGIN}/mcp`), {
    fetch: fetchApp,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
};
const call = async (client: Client, name: string, args: Json = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as Json;
  const parsed = JSON.parse(res.content[0].text);
  return { isError: !!res.isError, data: (res.structuredContent ?? parsed) as Json, error: parsed.error as Json };
};
const eventsOf = (batchId: string) =>
  t.db
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.batchId, batchId)));
const widgets = async () => (await body(await t.api(admin, acmeId).get(`/dashboards/${dashId}`))).widgets as Json[];

beforeAll(async () => {
  t = await createTestContext();
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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const as = t.api(admin, acmeId);
  wsId = (await body(await as.get('/workspaces'))).data[0].id;
  leadsId = (await body(await as.post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  await as.post(`/boards/${leadsId}/columns`, { title: 'Status', type: 'status' });
  await as.post(`/boards/${leadsId}/columns`, { title: 'Deal', type: 'numbers' });
  dashId = (await body(await as.post(`/workspaces/${wsId}/dashboards`, { name: 'Sales', board_ids: [leadsId] }))).id;
});
afterAll(() => t.close());

describe('dashboard widget tools', () => {
  it('list_dashboards and get_dashboard: the dashboard, its boards and the columns widgets name', async () => {
    const client = await connect(await mint(admin, ['boards:read']));
    const list = await call(client, 'list_dashboards');
    expect(list.isError, JSON.stringify(list.error)).toBe(false);
    expect(list.data.workspaces).toEqual([
      expect.objectContaining({ id: wsId, dashboards: [expect.objectContaining({ id: dashId, name: 'Sales' })] }),
    ]);
    const one = await call(client, 'get_dashboard', { dashboard_id: dashId });
    expect(one.data).toMatchObject({ id: dashId, name: 'Sales', can_edit: true, widgets: [] });
    expect(one.data.boards).toEqual([expect.objectContaining({ id: leadsId, name: 'Leads' })]);
    expect(one.data.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'status', title: 'Status', labels: expect.any(Array) }),
        expect.objectContaining({ type: 'numbers', title: 'Deal' }),
      ]),
    );
    // A read-only token sees no write tools.
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('get_dashboard');
    expect(names).not.toContain('add_dashboard_widget');
    await client.close();
  });

  it('adds, changes and removes widgets — each call one MCP batch that undo reverts', async () => {
    const client = await connect(await mint(admin, ['boards:write', 'items:write']));
    const status = { type: 'status', title: 'Status' };
    const added = await call(client, 'add_dashboard_widget', {
      dashboard_id: dashId,
      type: 'chart',
      title: 'By status',
      settings: { chart_type: 'pie', x: { kind: 'column', column: status } },
    });
    expect(added.isError, JSON.stringify(added.error)).toBe(false);
    expect(added.data).toMatchObject({ type: 'chart', title: 'By status', dashboard_id: dashId });
    expect(added.data.settings).toMatchObject({ chart_type: 'pie', measure: { fn: 'count' } });
    const ev = await eventsOf(added.data.batch_id);
    expect(ev.map((e) => e.type)).toEqual(['dashboard.widget_added']);
    expect((ev[0]!.payload.meta as Json).via).toBe('mcp');
    const kpi = await call(client, 'add_dashboard_widget', {
      dashboard_id: dashId,
      type: 'numbers',
      settings: { measure: { fn: 'sum', column: { type: 'numbers', title: 'Deal' } }, prefix: '$' },
      position: { x: 6, y: 0, w: 3, h: 2 },
    });
    expect(kpi.data.position).toEqual({ x: 6, y: 0, w: 3, h: 2 });
    expect((await widgets()).map((w) => w.id).sort()).toEqual([added.data.id, kpi.data.id].sort());

    // Settings are merged: only what changes is sent. A move goes through the layout.
    const changed = await call(client, 'update_dashboard_widget', {
      widget_id: kpi.data.id,
      title: 'Pipeline',
      settings: { suffix: ' total' },
      position: { x: 0, y: 4, w: 4, h: 2 },
    });
    expect(changed.isError, JSON.stringify(changed.error)).toBe(false);
    expect(changed.data).toMatchObject({ title: 'Pipeline', position: { x: 0, y: 4, w: 4, h: 2 } });
    expect(changed.data.settings).toMatchObject({ prefix: '$', suffix: ' total', measure: { fn: 'sum' } });
    const undone = await call(client, 'undo', { batch_id: changed.data.batch_id });
    expect(undone.isError, JSON.stringify(undone.error)).toBe(false);
    const back = (await widgets()).find((w) => w.id === kpi.data.id)!;
    expect(back).toMatchObject({ title: '', position: { x: 6, y: 0, w: 3, h: 2 } });
    expect(back.settings.suffix).toBe('');

    // Removed, then back with undo; an added widget is removed by undo.
    const removed = await call(client, 'remove_dashboard_widget', { widget_id: kpi.data.id });
    expect(removed.data.ok).toBe(true);
    expect((await widgets()).map((w) => w.id)).toEqual([added.data.id]);
    await call(client, 'undo', { batch_id: removed.data.batch_id });
    expect((await widgets()).map((w) => w.id)).toContain(kpi.data.id);
    await call(client, 'undo', { batch_id: added.data.batch_id });
    expect((await widgets()).map((w) => w.id)).toEqual([kpi.data.id]);
    await client.close();
  });

  it('refuses bad settings (with the issues), an unknown type, and a member who only views the dashboard', async () => {
    const client = await connect(await mint(admin, ['boards:write']));
    const bad = await call(client, 'add_dashboard_widget', {
      dashboard_id: dashId,
      type: 'chart',
      settings: { chart_type: 'radar' },
    });
    expect(bad.isError).toBe(true);
    expect(bad.error.code).toBe('validation_failed');
    expect(JSON.stringify(bad.error.details)).toContain('chart_type');
    const unknown = (await client.callTool({
      name: 'add_dashboard_widget',
      arguments: { dashboard_id: dashId, type: 'nope' },
    })) as Json;
    expect(unknown.isError).toBe(true);
    await client.close();

    const member = await connect(await mint(bob, ['boards:write']));
    const seen = await call(member, 'get_dashboard', { dashboard_id: dashId });
    expect(seen.data.can_edit).toBe(false);
    const refused = await call(member, 'add_dashboard_widget', { dashboard_id: dashId, type: 'text' });
    expect(refused.isError).toBe(true);
    expect(refused.error.code).toBe('forbidden');
    await member.close();
  });

  it('the plan: without the dashboards feature, reading works and changing widgets is refused', async () => {
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    const token = await mint(admin, ['boards:write']);
    const plan = await body(
      await t.api(owner).post('/platform/plans', { name: 'API only', version: { features: ['api'] } }),
    );
    const put = await t
      .api(owner)
      .put(`/platform/accounts/${acmeId}/subscription`, { plan_version_id: plan.versions[0].id });
    expect(put.status).toBe(200);
    const client = await connect(token);
    expect((await call(client, 'get_dashboard', { dashboard_id: dashId })).isError).toBe(false);
    const refused = await call(client, 'add_dashboard_widget', { dashboard_id: dashId, type: 'text' });
    expect(refused.isError).toBe(true);
    expect(refused.error).toMatchObject({ code: 'plan_feature_unavailable', details: { feature: 'dashboards' } });
    await client.close();
  });
});
