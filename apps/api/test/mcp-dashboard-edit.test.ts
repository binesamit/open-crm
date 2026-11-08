// SPDX-License-Identifier: AGPL-3.0-only
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Editing an existing dashboard with AI: update_dashboard (name, description, sources, filter bar
 * folder, who sees it — that one is sensitive), set_dashboard_layout, duplicate a widget / the dashboard, delete it —
 * each through the dashboard service, each one undoable batch (creating a dashboard too, now).
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

const call2 = (client: Client, name: string, args: Json) => call(client, name, args);
const dash = async (id = dashId) => body(await t.api(admin, acmeId).get(`/dashboards/${id}`));

describe('editing a dashboard', () => {
  it('update_dashboard: name, description, sources and filter bar — undo puts them back', async () => {
    const client = await connect(await mint(admin, ['boards:write', 'items:write']));
    const other = (await body(await t.api(admin, acmeId).post('/boards', { name: 'Clients', workspace_id: wsId }))).id;
    const res = await call2(client, 'update_dashboard', {
      dashboard_id: dashId,
      name: 'Sales 2026',
      description: 'The team’s numbers',
      board_ids: [leadsId, other],
      filter: { person: 'me' },
    });
    expect(res.isError, JSON.stringify(res.error)).toBe(false);
    expect(res.data).toMatchObject({ name: 'Sales 2026', board_ids: [leadsId, other], filter: { person: 'me' } });
    expect(await dash()).toMatchObject({ name: 'Sales 2026', description: 'The team’s numbers' });
    expect((await call2(client, 'undo', { batch_id: res.data.batch_id })).isError).toBe(false);
    const back = await dash();
    expect(back).toMatchObject({ name: 'Sales' });
    expect(back.settings.board_ids).toEqual([leadsId]);
    expect(back.settings.filter).toEqual({});
    await client.close();
  });

  it('set_dashboard_layout, duplicate_dashboard_widget — and undo of each', async () => {
    const client = await connect(await mint(admin, ['boards:write', 'items:write']));
    const a = await call2(client, 'add_dashboard_widget', {
      dashboard_id: dashId,
      type: 'text',
      title: 'Note',
      settings: { text: 'hi' },
    });
    const b = await call2(client, 'add_dashboard_widget', { dashboard_id: dashId, type: 'numbers', title: 'Count' });
    const laid = await call2(client, 'set_dashboard_layout', {
      dashboard_id: dashId,
      widgets: [
        { widget_id: a.data.id, position: { x: 6, y: 0, w: 6, h: 2 } },
        { widget_id: b.data.id, position: { x: 0, y: 0, w: 6, h: 2 } },
      ],
    });
    expect(laid.isError, JSON.stringify(laid.error)).toBe(false);
    const pos = (id: string) => (laid.data.widgets as Json[]).find((w) => w.id === id)!.position;
    expect(pos(a.data.id)).toEqual({ x: 6, y: 0, w: 6, h: 2 });
    expect(pos(b.data.id)).toEqual({ x: 0, y: 0, w: 6, h: 2 });
    await call2(client, 'undo', { batch_id: laid.data.batch_id });
    expect(((await dash()).widgets as Json[]).find((w) => w.id === a.data.id)!.position).toEqual(a.data.position);
    const copy = await call2(client, 'duplicate_dashboard_widget', { widget_id: a.data.id, title: 'Note 2' });
    expect(copy.data).toMatchObject({ type: 'text', title: 'Note 2', settings: { text: 'hi' } });
    await call2(client, 'undo', { batch_id: copy.data.batch_id });
    expect(((await dash()).widgets as Json[]).some((w) => w.id === copy.data.id)).toBe(false);
    await client.close();
  });

  it('create / duplicate / delete a dashboard — each undoable (to the trash and back)', async () => {
    const client = await connect(await mint(admin, ['boards:write', 'items:write']));
    const made = await call2(client, 'create_dashboard', { workspace_id: wsId, name: 'Temp', board_ids: [leadsId] });
    expect((await call2(client, 'undo', { batch_id: made.data.batch_id })).isError).toBe(false);
    expect((await t.api(admin, acmeId).get(`/dashboards/${made.data.id}`)).status).toBe(404);
    const dup = await call2(client, 'duplicate_dashboard', { dashboard_id: dashId, name: 'Sales copy' });
    expect(dup.data.name).toBe('Sales copy');
    expect(((await dash(dup.data.id)).widgets as Json[]).length).toBe(((await dash()).widgets as Json[]).length);
    const del = await call2(client, 'delete_dashboard', { dashboard_id: dup.data.id });
    expect(del.isError, JSON.stringify(del.error)).toBe(false);
    expect((await t.api(admin, acmeId).get(`/dashboards/${dup.data.id}`)).status).toBe(404);
    await call2(client, 'undo', { batch_id: del.data.batch_id });
    expect((await t.api(admin, acmeId).get(`/dashboards/${dup.data.id}`)).status).toBe(200);
    await client.close();
  });

  it('who sees it is a sensitive change: blocked where the account blocks sensitive AI actions; a member is refused', async () => {
    const member = await connect(await mint(bob, ['boards:write']));
    const refused = await call2(member, 'update_dashboard', { dashboard_id: dashId, name: 'Mine' });
    expect(refused.error.code).toBe('forbidden');
    await member.close();
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_sensitive: 'block' });
    const client = await connect(await mint(admin, ['boards:write']));
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('update_dashboard');
    expect(names).not.toContain('delete_dashboard');
    const kind = await call2(client, 'update_dashboard', { dashboard_id: dashId, kind: 'private' });
    expect(kind.isError).toBe(true);
    expect(kind.error.code).toBe('forbidden');
    expect((await call2(client, 'update_dashboard', { dashboard_id: dashId, name: 'Sales' })).isError).toBe(false);
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_sensitive: 'allow' });
    await client.close();
  });
});
