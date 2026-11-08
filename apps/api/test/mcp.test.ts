// SPDX-License-Identifier: AGPL-3.0-only
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { and, eq } from 'drizzle-orm';
import { newId } from '@bines/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountMembers, activityLog, apiTokens, users } from '../src/db/schema';
import { hashToken } from '../src/modules/tokens/tokens.service';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * The MCP server (the planning notes "AGENTS-MCP" מ2–מ4): `/mcp` over Streamable HTTP with the official SDK client —
 * both eras (2025-11-25 initialize, 2026-07-28 stateless), read and write tools, one permission path (board
 * limits, roles, guests, other accounts), the MCP action log and undo.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let otherId: string;
let leadsId: string;
let secretId: string;
let statusKey: string;
let labels: { id: number; label: string }[];
let groupIds: string[];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const mint = async (cookie: string, accountId: string, scopes: string[], extra: Json = {}) =>
  (await body(await t.api(cookie, accountId).post('/auth/tokens', { name: 'Claude Code', scopes, ...extra })))
    .token as string;
/** A token straight in the table (viewers and guests cannot mint one; a role can change after minting). */
const rawToken = async (email: string, accountId: string, scopes: string[]) => {
  const user = (await t.db.select().from(users).where(eq(users.email, email)))[0]!;
  const token = `bos_pat_${newId()}${newId().slice(0, 14)}`;
  await t.db.insert(apiTokens).values({
    id: newId(),
    accountId,
    userId: user.id,
    name: 'raw',
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 12),
    scopes,
  });
  return token;
};

const fetchApp = (url: string | URL | Request, init?: RequestInit) =>
  t.app.request(url instanceof Request ? url : String(url), init) as Promise<Response>;

/** An SDK client on the in-process app; `pin` = the 2026-07-28 stateless era, else the 2025 initialize handshake. */
const connect = async (token: string, opts: { modern?: boolean } = {}) => {
  const client = new Client(
    { name: 'bines-test', version: '1.0.0' },
    opts.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
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
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'admin@other.test');
  admin = await join('admin@acme.test');
  await join('admin@other.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  await join('carol@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['gina@outside.test'], role: 'guest' });
  await join('gina@outside.test');
  const as = t.api(admin, acmeId);
  const wsId = (await body(await as.get('/workspaces'))).data[0].id;
  leadsId = (await body(await as.post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  secretId = (await body(await as.post('/boards', { name: 'Secret plans', workspace_id: wsId }))).id;
  statusKey = (await body(await as.post(`/boards/${leadsId}/columns`, { title: 'סטטוס', type: 'status' }))).id;
  await as.post(`/boards/${leadsId}/columns`, { id: 'time', title: 'זמן', type: 'time_tracking' });
  const board = await body(await as.get(`/boards/${leadsId}`));
  labels = board.columns.find((c: Json) => c.id === statusKey).settings.labels;
  groupIds = board.groups.map((g: Json) => g.id);
  await as.post(`/boards/${leadsId}/items`, { name: 'Dana Levi' });
  await as.post(`/boards/${secretId}/items`, { name: 'Top secret' });
});
afterAll(() => t.close());

describe('MCP server — protocol', () => {
  it('serves a 2025-11-25 client: initialize, tools/list, tools/call', async () => {
    const token = await mint(bob, acmeId, ['boards:read', 'items:write', 'updates:write', 'search', 'users:read']);
    const client = await connect(token);
    expect(client.getServerVersion()?.name).toBe('bines-os');
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name);
    expect(names).toContain('query_items');
    expect(names).toContain('create_item');
    // Deterministic order (registry order), annotations for clients that ask before destructive calls.
    expect(names.indexOf('whoami')).toBe(0);
    expect(tools.find((x) => x.name === 'delete_item')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((x) => x.name === 'get_board')?.annotations?.readOnlyHint).toBe(true);
    // No automation scope → no automation tools.
    expect(names).not.toContain('create_automation');
    const me = await call(client, 'whoami');
    expect(me.data).toMatchObject({ user: { email: 'bob@acme.test' }, account: { id: acmeId }, role: 'member' });
    await client.close();
  });

  it('serves a 2026-07-28 client statelessly (server/discover, no session)', async () => {
    const token = await mint(bob, acmeId, ['boards:read']);
    const client = await connect(token, { modern: true });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.every((x) => x.annotations?.readOnlyHint)).toBe(true);
    const found = await call(client, 'search_boards', { query: 'lead' });
    expect(found.data.boards.map((b: Json) => b.id)).toEqual([leadsId]);
    await client.close();
  });

  it('401 without a token / with a bad one, with WWW-Authenticate', async () => {
    const bare = await t.app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(bare.status).toBe(401);
    expect(bare.headers.get('www-authenticate')).toMatch(/^Bearer /);
    const bad = await t.app.request('/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer bos_pat_nope', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(bad.status).toBe(401);
  });
});

describe('MCP server — read tools and permissions', () => {
  it('reads boards, items with filters, item details', async () => {
    const client = await connect(await mint(bob, acmeId, ['boards:read']));
    const b = await call(client, 'get_board', { board_id: leadsId });
    expect(b.data.columns.map((c: Json) => c.id)).toContain(statusKey);
    const q = await call(client, 'query_items', {
      board_id: leadsId,
      filter: { operator: 'and', rules: [{ column_id: 'name', operator: 'contains_text', values: ['dana'] }] },
    });
    expect(q.isError).toBe(false);
    expect(q.data.items.map((i: Json) => i.name)).toEqual(['Dana Levi']);
    const one = await call(client, 'get_item', { item_id: q.data.items[0].id });
    expect(one.data).toMatchObject({ name: 'Dana Levi', board: { id: leadsId } });
    const ws = await call(client, 'list_workspaces');
    expect(ws.data.workspaces[0].boards.map((x: Json) => x.name)).toEqual(
      expect.arrayContaining(['Leads', 'Secret plans']),
    );
    await client.close();
  });

  it('a token limited to one board cannot see another', async () => {
    const client = await connect(await mint(bob, acmeId, ['boards:read', 'search'], { board_ids: [leadsId] }));
    const ws = await call(client, 'list_workspaces');
    expect(ws.data.workspaces.flatMap((w: Json) => w.boards.map((x: Json) => x.id))).toEqual([leadsId]);
    const other = await call(client, 'get_board', { board_id: secretId });
    expect(other.isError).toBe(true);
    expect(other.error.code).toBe('not_found');
    const s = await call(client, 'search', { query: 'secret' });
    expect(s.data.items).toEqual([]);
    expect(s.data.boards).toEqual([]);
    expect((await call(client, 'query_items', { board_id: secretId })).error.code).toBe('not_found');
    await client.close();
  });

  it('a token of another account sees nothing here (404 — no existence leak)', async () => {
    const otherAdmin = t.cookieFrom((await t.signInWithMagicLink('admin@other.test')).res);
    const client = await connect(await mint(otherAdmin!, otherId, ['admin']));
    const r = await call(client, 'get_board', { board_id: leadsId });
    expect(r.error.code).toBe('not_found');
    const me = await call(client, 'whoami');
    expect(me.data.account.id).toBe(otherId);
    await client.close();
  });

  it('viewers are not allowed by default; when allowed they only read', async () => {
    const token = await rawToken('carol@acme.test', acmeId, ['boards:read', 'items:write']);
    const res = await t.app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('mcp_role_not_allowed');

    expect((await t.api(admin, acmeId).patch('/ai/settings', { mcp_roles: ['member', 'viewer'] })).status).toBe(200);
    const client = await connect(token);
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('get_board');
    expect(names).not.toContain('create_item');
    // A tool this connection does not have does not exist for it (JSON-RPC invalid params).
    await expect(client.callTool({ name: 'create_item', arguments: { board_id: leadsId, name: 'x' } })).rejects.toThrow(
      /not found/,
    );
    await client.close();
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_roles: ['member'] });
  });

  it('guests never connect (even with an old token)', async () => {
    const token = await rawToken('gina@outside.test', acmeId, ['boards:read']);
    const res = await t.app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(403);
  });

  it('the account can switch MCP off', async () => {
    const token = await mint(bob, acmeId, ['boards:read']);
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_enabled: false });
    const res = await t.app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(403);
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_enabled: true });
  });
});

describe('MCP server — write tools and the action log', () => {
  it('creates an item with text cell values as the user, marked via=mcp, one batch per call, undoable', async () => {
    const client = await connect(await mint(bob, acmeId, ['boards:read', 'items:write']));
    const created = await call(client, 'create_item', {
      board_id: leadsId,
      name: 'Yossi',
      group_id: groupIds[0],
      cells: { [statusKey]: labels[1]!.label },
    });
    expect(created.isError).toBe(false);
    expect(created.data.cells[statusKey].text).toBe(labels[1]!.label);
    const batchId = created.data.batch_id as string;
    const events = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.batchId, batchId)));
    expect(events.map((e) => e.type).sort()).toEqual(['cell.changed', 'item.created']);
    const bobId = (await t.db.select().from(users).where(eq(users.email, 'bob@acme.test')))[0]!.id;
    for (const e of events) {
      expect(e.actorId).toBe(bobId);
      expect(e.actorType).toBe('api');
      expect((e.payload.meta as Json).via).toBe('mcp');
      expect((e.payload.meta as Json).mcp).toMatchObject({ tool: 'create_item', client: 'Claude Code' });
    }

    // An unreadable label names the board's labels so the model can fix its call.
    const bad = await call(client, 'update_item', { item_id: created.data.id, cells: { [statusKey]: 'nope' } });
    expect(bad.isError).toBe(true);
    expect(bad.error.code).toBe('invalid_value');
    expect(bad.error.details.labels).toContain(labels[1]!.label);

    // The whole call undoes as one.
    const undone = await call(client, 'undo', { batch_id: batchId });
    expect(undone.isError).toBe(false);
    const gone = await call(client, 'get_item', { item_id: created.data.id });
    expect(gone, JSON.stringify(gone)).toMatchObject({ isError: true });
    expect(gone.error.code).toBe('not_found');
    await client.close();
  });

  it('reads a date with a time as wall-clock time in the account zone', async () => {
    const dateKey = (
      await body(
        await t
          .api(admin, acmeId)
          .post(`/boards/${leadsId}/columns`, { title: 'פגישה', type: 'date', settings: { show_time: true } }),
      )
    ).id as string;
    const client = await connect(await mint(bob, acmeId, ['boards:read', 'items:write']));
    const item = (await call(client, 'create_item', { board_id: leadsId, name: 'Dana' })).data;
    // The account default zone is Asia/Jerusalem (UTC+3 on Oct 5): 14:30 there = 11:30Z.
    const res = await call(client, 'update_item', { item_id: item.id, cells: { [dateKey]: '05/10/2026 14:30' } });
    expect(res.isError, JSON.stringify(res)).toBe(false);
    expect(res.data.cells[dateKey].value).toEqual({ date: '2026-10-05', time: '11:30' });
    expect(res.data.cells[dateKey].text).toContain('14:30');
    // A plain date stays a plain date.
    const plain = await call(client, 'update_item', { item_id: item.id, cells: { [dateKey]: '06/10/2026' } });
    expect(plain.data.cells[dateKey].value).toEqual({ date: '2026-10-06' });
    await client.close();
  });

  it('update, move, archive, delete, updates and time — each through its service', async () => {
    const client = await connect(
      await mint(bob, acmeId, ['boards:read', 'items:write', 'updates:write', 'updates:read']),
    );
    const item = (await call(client, 'create_item', { board_id: leadsId, name: 'Moshe' })).data;
    const renamed = await call(client, 'update_item', { item_id: item.id, name: 'Moshe Cohen' });
    expect(renamed.data.name).toBe('Moshe Cohen');
    const moved = await call(client, 'move_item', { item_id: item.id, group_id: groupIds[1] ?? groupIds[0] });
    expect(moved.isError).toBe(false);
    const upd = await call(client, 'create_update', { item_id: item.id, text: 'שיחה ראשונה' });
    expect(upd.data.text).toBe('שיחה ראשונה');
    const reply = await call(client, 'reply_update', { update_id: upd.data.id, text: 'תודה' });
    expect(reply.isError).toBe(false);
    const list = await call(client, 'list_updates', { item_id: item.id });
    expect(list.data.updates[0].replies[0].text).toBe('תודה');
    const logged = await call(client, 'log_time', {
      item_id: item.id,
      column_id: 'time',
      started_at: '2026-10-01T08:00:00+03:00',
      duration_minutes: 30,
    });
    expect(logged.isError).toBe(false);
    expect((await call(client, 'list_time_entries', { item_id: item.id })).data.entries).toHaveLength(1);
    const activity = await call(client, 'item_activity', { item_id: item.id });
    expect(activity.data.events.length).toBeGreaterThan(2);
    expect((await call(client, 'archive_item', { item_id: item.id })).data.ok).toBe(true);
    const other = (await call(client, 'create_item', { board_id: leadsId, name: 'To delete' })).data;
    expect((await call(client, 'delete_item', { item_id: other.id })).data.ok).toBe(true);
    await client.close();
  });

  it('a read-only token has no write tools; the board permission set is enforced by the service', async () => {
    const ro = await connect(await mint(bob, acmeId, ['boards:read']));
    await expect(ro.callTool({ name: 'create_item', arguments: { board_id: leadsId, name: 'x' } })).rejects.toThrow(
      /not found/,
    );
    await ro.close();

    await t.api(admin, acmeId).patch(`/boards/${secretId}`, { permission_set: 'view_comment' });
    const rw = await connect(await mint(bob, acmeId, ['boards:read', 'items:write']));
    const denied = await call(rw, 'create_item', { board_id: secretId, name: 'nope' });
    expect(denied.isError).toBe(true);
    expect(denied.error.code).toBe('forbidden');
    await rw.close();
  });

  it('sensitive tools can be blocked by the account', async () => {
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_sensitive: 'block' });
    const client = await connect(await mint(bob, acmeId, ['boards:read', 'items:write']));
    expect((await client.listTools()).tools.map((x) => x.name)).not.toContain('delete_item');
    await client.close();
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_sensitive: 'allow' });
  });

  it('creates automations through validateRecipe — problems come back as issues to fix', async () => {
    const client = await connect(await mint(admin, acmeId, ['boards:read', 'automations:write']));
    const bad = await call(client, 'create_automation', {
      board_id: leadsId,
      recipe: { trigger: { type: 'status_changed', column: statusKey, labels: ['אין כזו'] }, actions: [] },
    });
    expect(bad.isError).toBe(true);
    expect(bad.error.code).toBe('invalid_recipe');
    expect(bad.error.details.issues.length).toBeGreaterThan(0);
    const ok = await call(client, 'create_automation', {
      board_id: leadsId,
      recipe: {
        trigger: { type: 'status_changed', column: statusKey, labels: [labels[1]!.label] },
        actions: [{ type: 'archive_item' }],
      },
    });
    expect(ok.isError).toBe(false);
    expect(ok.data.is_active).toBe(false);
    const on = await call(client, 'set_automation_active', { automation_id: ok.data.id, is_active: true });
    expect(on.data.is_active).toBe(true);
    const listed = await call(client, 'list_automations', { board_id: leadsId });
    expect(listed.data.automations.map((a: Json) => a.id)).toContain(ok.data.id);
    await call(client, 'set_automation_active', { automation_id: ok.data.id, is_active: false });
    await client.close();
  });

  it('write calls have their own rate limit per token', async () => {
    const { aiWriteLimiter } = await import('../src/modules/ai/tools/guard');
    const client = await connect(await mint(bob, acmeId, ['boards:read', 'items:write']));
    const tokenRow = (await t.db.select().from(apiTokens).where(eq(apiTokens.accountId, acmeId))).at(-1)!;
    const perMinute = (await body(await t.api(admin, acmeId).get('/ai/settings'))).write_rate_per_minute as number;
    for (let i = 0; i < perMinute; i++) aiWriteLimiter.take(`token:${tokenRow.id}`, perMinute);
    const limited = await call(client, 'create_item', { board_id: leadsId, name: 'too many' });
    expect(limited.error.code).toBe('rate_limited');
    await client.close();
  });
});

describe('MCP connection page data', () => {
  it('GET /ai/mcp gives the address on the web origin and my tools', async () => {
    const info = await body(await t.api(bob, acmeId).get('/ai/mcp'));
    expect(info).toMatchObject({ url: `${WEB_ORIGIN}/mcp`, enabled: true, allowed: true });
    expect(info.protocol_versions).toContain('2026-07-28');
    expect(info.tools.map((x: Json) => x.name)).toContain('create_item');
    const member = (await t.db.select().from(accountMembers).where(eq(accountMembers.accountId, acmeId))).length;
    expect(member).toBeGreaterThan(2);
  });
});
