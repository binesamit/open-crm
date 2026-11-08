// SPDX-License-Identifier: AGPL-3.0-only
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { and, eq } from 'drizzle-orm';
import { GROUP_COLOR_KEYS, newId } from '@bines/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activityLog, apiTokens, users } from '../src/db/schema';
import type * as Outbound from '../src/lib/outbound';
import { hashToken } from '../src/modules/tokens/tokens.service';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * The MCP tools added after מ4 (the planning notes "AGENTS-MCP" §4): structure writes (create_board, create_group,
 * update_group, create_column, update_column), move_item_to_board, files (get_file_link, attach_file_from_url),
 * my_work, test_automation and automation_runs — each through its service, with the same refusals as the rest:
 * roles, the board permission set, a token's board limit, another account.
 */

// Downloads: one fake public host serves files; every other URL goes through the real SSRF guard.
const downloads = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../src/lib/outbound', async (importOriginal) => {
  const actual = await importOriginal<typeof Outbound>();
  return {
    ...actual,
    outboundDownload: async (url: string, opts: Parameters<typeof actual.outboundDownload>[1]) => {
      downloads.calls.push(url);
      const u = new URL(url);
      if (u.hostname !== 'files.example.com') return actual.outboundDownload(url, opts);
      if (u.pathname.endsWith('.html'))
        return { url, mime: 'text/html', fileName: 'page.html', body: Buffer.from('<html></html>') };
      return { url, mime: 'application/pdf', fileName: 'quote.pdf', body: Buffer.from('%PDF-1.4 fake') };
    },
  };
});

let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let otherId: string;
let otherAdmin: string;
let wsId: string;
let leadsId: string;
let secretId: string;
let targetId: string;
let statusKey: string;
let peopleKey: string;
let filesKey: string;
let labels: { id: number; label: string }[];
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
const toolNames = async (client: Client) => (await client.listTools()).tools.map((x) => x.name);
const eventsOf = (batchId: string) =>
  t.db
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.batchId, batchId)));

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
  otherAdmin = await join('admin@other.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  await join('carol@acme.test');
  const as = t.api(admin, acmeId);
  wsId = (await body(await as.get('/workspaces'))).data[0].id;
  leadsId = (await body(await as.post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  secretId = (await body(await as.post('/boards', { name: 'Secret plans', workspace_id: wsId }))).id;
  targetId = (await body(await as.post('/boards', { name: 'Clients', workspace_id: wsId }))).id;
  statusKey = (await body(await as.post(`/boards/${leadsId}/columns`, { title: 'סטטוס', type: 'status' }))).id;
  peopleKey = (await body(await as.post(`/boards/${leadsId}/columns`, { title: 'אחראי', type: 'people' }))).id;
  filesKey = (await body(await as.post(`/boards/${leadsId}/columns`, { title: 'קבצים', type: 'file' }))).id;
  await as.post(`/boards/${targetId}/columns`, { title: 'סטטוס', type: 'status' });
  const board = await body(await as.get(`/boards/${leadsId}`));
  labels = board.columns.find((c: Json) => c.id === statusKey).settings.labels;
  await as.post(`/boards/${secretId}/items`, { name: 'Top secret' });
});
afterAll(() => t.close());

describe('structure tools: create_board, create_group, update_group, create_column, update_column', () => {
  it('builds a board through the board services — every change an MCP event of its own batch', async () => {
    const client = await connect(await mint(admin, acmeId, ['boards:write']));
    const blank = await call(client, 'create_board', { workspace_id: wsId, name: 'Pipeline' });
    expect(blank.isError, JSON.stringify(blank.error)).toBe(false);
    expect(blank.data).toMatchObject({ name: 'Pipeline', workspace_id: wsId, kind: 'main' });
    expect(blank.data.columns.map((c: Json) => c.type)).toEqual(['name']);
    expect(blank.data.groups).toHaveLength(1);
    const created = await eventsOf(blank.data.batch_id);
    expect(created.map((e) => e.type)).toEqual(['board.created']);
    expect((created[0]!.payload.meta as Json).via).toBe('mcp');
    const boardId = blank.data.id as string;

    const g = await call(client, 'create_group', { board_id: boardId, title: 'Hot', color: GROUP_COLOR_KEYS[2] });
    expect(g.data).toMatchObject({ title: 'Hot', color: GROUP_COLOR_KEYS[2] });
    const first = blank.data.groups[0].id as string;
    const moved = await call(client, 'update_group', {
      board_id: boardId,
      group_id: g.data.id,
      title: 'Very hot',
      color: GROUP_COLOR_KEYS[4],
      position: { after_id: first },
    });
    expect(moved.data).toMatchObject({ id: g.data.id, title: 'Very hot', color: GROUP_COLOR_KEYS[4] });
    expect((await eventsOf(moved.data.batch_id)).map((e) => e.type).sort()).toEqual([
      'group.reordered',
      'group.updated',
    ]);
    const read = await call(client, 'get_board', { board_id: boardId });
    expect(read.data.groups.map((x: Json) => x.title)).toEqual([blank.data.groups[0].title, 'Very hot']);
    expect((await call(client, 'update_group', { board_id: boardId, group_id: first })).error.code).toBe('bad_request');

    const col = await call(client, 'create_column', { board_id: boardId, title: 'Stage', type: 'status' });
    expect(col.data).toMatchObject({ title: 'Stage', type: 'status' });
    expect(col.data.settings.labels.length).toBeGreaterThan(0);
    const num = await call(client, 'create_column', {
      board_id: boardId,
      id: 'amount',
      title: 'Amount',
      type: 'numbers',
    });
    expect(num.data.id).toBe('amount');
    // a new numbers column shows a thousands separator, also when settings leave it out.
    expect(num.data.settings).toMatchObject({ footer: 'sum', thousands: true });
    const priced = await call(client, 'create_column', {
      board_id: boardId,
      title: 'Price',
      type: 'numbers',
      settings: { unit: { symbol: '$', direction: 'left' } },
    });
    expect(priced.data.settings).toMatchObject({ unit: { symbol: '$' }, thousands: true });
    const plain = await call(client, 'create_column', {
      board_id: boardId,
      title: 'Plain',
      type: 'numbers',
      settings: { thousands: false },
    });
    expect(plain.data.settings.thousands).toBe(false);
    const badType = await call(client, 'create_column', { board_id: boardId, title: 'x', type: 'nope' });
    expect(badType.error.code).toBe('unknown_column_type');
    const badSettings = await call(client, 'create_column', {
      board_id: boardId,
      title: 'y',
      type: 'status',
      settings: { labels: 'nope' },
    });
    expect(badSettings.error.code).toBe('validation_failed');

    const labelsNow = col.data.settings.labels as Json[];
    const renamed = await call(client, 'update_column', {
      board_id: boardId,
      column_id: col.data.id,
      title: 'Deal stage',
      settings: { labels: [...labelsNow, { id: 90, label: 'Won', color: 'forest', index: labelsNow.length }] },
      position: { after_id: 'amount' },
    });
    expect(renamed.isError, JSON.stringify(renamed.error)).toBe(false);
    expect(renamed.data.title).toBe('Deal stage');
    expect(renamed.data.settings.labels.map((l: Json) => l.label)).toContain('Won');
    const after = await call(client, 'get_board', { board_id: boardId });
    expect(after.data.columns.map((c: Json) => c.id)).toEqual([
      'name',
      'amount',
      col.data.id,
      priced.data.id,
      plain.data.id,
    ]);
    // The name column stays first.
    const nameFirst = await call(client, 'update_column', { board_id: boardId, column_id: 'name', position: 'top' });
    expect(nameFirst.error.code).toBe('bad_request');
    await client.close();
  });

  it('creates a board from a template; an unknown key lists the templates', async () => {
    const client = await connect(await mint(admin, acmeId, ['boards:write']));
    const bad = await call(client, 'create_board', { workspace_id: wsId, template_key: 'no_such_template' });
    expect(bad.error.code).toBe('not_found');
    const templates = bad.error.details.templates as Json[];
    expect(templates.length).toBeGreaterThan(0);
    const ok = await call(client, 'create_board', { workspace_id: wsId, template_key: templates[0]!.key });
    expect(ok.isError, JSON.stringify(ok.error)).toBe(false);
    expect(ok.data.columns.length).toBeGreaterThan(1);
    await client.close();
  });

  it('refusals: viewers get no structure tools, the permission set, a board-limited token, another account', async () => {
    // A viewer (when the account lets viewers connect) reads only.
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_roles: ['member', 'viewer'] });
    const viewer = await connect(await rawToken('carol@acme.test', acmeId, ['boards:write']));
    const names = await toolNames(viewer);
    for (const n of ['create_board', 'create_group', 'update_group', 'create_column', 'update_column'])
      expect(names).not.toContain(n);
    await viewer.close();
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_roles: ['member'] });

    // A board read-only for members: the service refuses.
    await t.api(admin, acmeId).patch(`/boards/${secretId}`, { permission_set: 'view_comment' });
    const member = await connect(await mint(bob, acmeId, ['boards:write']));
    expect((await call(member, 'create_group', { board_id: secretId, title: 'x' })).error.code).toBe('forbidden');
    expect((await call(member, 'create_column', { board_id: secretId, title: 'x', type: 'text' })).error.code).toBe(
      'forbidden',
    );
    await member.close();

    // A token limited to one board: nothing outside it, and no new boards.
    const limited = await connect(await mint(admin, acmeId, ['boards:write'], { board_ids: [leadsId] }));
    expect((await call(limited, 'create_group', { board_id: secretId, title: 'x' })).error.code).toBe('not_found');
    expect(
      (await call(limited, 'update_column', { board_id: secretId, column_id: 'name', title: 'x' })).error.code,
    ).toBe('not_found');
    expect((await call(limited, 'create_board', { workspace_id: wsId, name: 'x' })).error.code).toBe('forbidden');
    expect((await call(limited, 'create_group', { board_id: leadsId, title: 'Inside' })).isError).toBe(false);
    await limited.close();

    // Another account's token: this account's boards and workspaces do not exist for it.
    const other = await connect(await mint(otherAdmin, otherId, ['admin']));
    expect((await call(other, 'create_group', { board_id: leadsId, title: 'x' })).error.code).toBe('not_found');
    expect((await call(other, 'create_board', { workspace_id: wsId, name: 'x' })).error.code).toBe('not_found');
    expect((await call(other, 'update_group', { board_id: leadsId, group_id: 'x', title: 'y' })).error.code).toBe(
      'not_found',
    );
    await other.close();
  });
});

describe('more structure tools (): workspaces, folders, moves, views, dashboards, docs, removals', () => {
  it('builds a workspace with a folder, a board moved into it, a view, a dashboard and a doc', async () => {
    const client = await connect(await mint(admin, acmeId, ['boards:write']));
    const ws = await call(client, 'create_workspace', { name: 'Sales', kind: 'closed' });
    expect(ws.isError, JSON.stringify(ws.error)).toBe(false);
    expect(ws.data).toMatchObject({ name: 'Sales', kind: 'closed' });
    const folder = await call(client, 'create_folder', { workspace_id: ws.data.id, name: 'Q4' });
    expect(folder.data).toMatchObject({ name: 'Q4', workspace_id: ws.data.id });
    const sub = await call(client, 'create_folder', {
      workspace_id: ws.data.id,
      name: 'Deals',
      parent_folder_id: folder.data.id,
    });
    expect(sub.data.parent_folder_id).toBe(folder.data.id);
    const board = await call(client, 'create_board', { workspace_id: ws.data.id, name: 'Pipeline Q4' });
    const moved = await call(client, 'move_board', { board_id: board.data.id, folder_id: sub.data.id });
    expect(moved.data).toMatchObject({ id: board.data.id, folder_id: sub.data.id });
    const root = await call(client, 'move_board', { board_id: board.data.id, folder_id: null });
    expect(root.data.folder_id).toBeNull();

    const view = await call(client, 'create_view', { board_id: board.data.id, name: 'Stages', type: 'kanban' });
    expect(view.isError, JSON.stringify(view.error)).toBe(false);
    expect(view.data).toMatchObject({ name: 'Stages', type: 'kanban' });
    // An unknown view type is refused by the tool's schema (the MCP layer), before any service runs.
    const badView = (await client.callTool({
      name: 'create_view',
      arguments: { board_id: board.data.id, name: 'x', type: 'nope' },
    })) as Json;
    expect(badView.isError).toBe(true);
    const dash = await call(client, 'create_dashboard', {
      workspace_id: ws.data.id,
      name: 'Q4 overview',
      folder_id: folder.data.id,
      board_ids: [board.data.id],
    });
    expect(dash.isError, JSON.stringify(dash.error)).toBe(false);
    expect(dash.data.name).toBe('Q4 overview');
    const doc = await call(client, 'create_doc', {
      workspace_id: ws.data.id,
      name: 'Playbook',
      folder_id: folder.data.id,
    });
    expect(doc.isError, JSON.stringify(doc.error)).toBe(false);
    expect(doc.data.name).toBe('Playbook');
    await client.close();
  });

  it('removes a column, a group and boards (archive / trash) — all sensitive, through the same services', async () => {
    const client = await connect(await mint(admin, acmeId, ['boards:write']));
    const names = await toolNames(client);
    for (const n of ['archive_board', 'delete_board', 'delete_group', 'delete_column']) expect(names).toContain(n);
    const b = await call(client, 'create_board', { workspace_id: wsId, name: 'To trim' });
    const col = await call(client, 'create_column', { board_id: b.data.id, title: 'Notes', type: 'text' });
    const g = await call(client, 'create_group', { board_id: b.data.id, title: 'Extra' });
    expect((await call(client, 'delete_column', { board_id: b.data.id, column_id: col.data.id })).data).toMatchObject({
      ok: true,
      trash: true,
    });
    expect((await call(client, 'delete_column', { board_id: b.data.id, column_id: 'name' })).isError).toBe(true);
    expect((await call(client, 'delete_group', { board_id: b.data.id, group_id: g.data.id })).data.ok).toBe(true);
    const read = await call(client, 'get_board', { board_id: b.data.id });
    expect(read.data.columns.map((c: Json) => c.id)).not.toContain(col.data.id);
    expect(read.data.groups.map((x: Json) => x.id)).not.toContain(g.data.id);

    const keep = await call(client, 'create_board', { workspace_id: wsId, name: 'To archive' });
    expect((await call(client, 'archive_board', { board_id: keep.data.id })).data).toMatchObject({ ok: true });
    expect((await call(client, 'delete_board', { board_id: b.data.id })).data).toMatchObject({ ok: true, trash: true });
    expect((await call(client, 'get_board', { board_id: b.data.id })).error.code).toBe('not_found');
    const trash = (await body(await t.api(admin, acmeId).get('/trash'))).data as Json[];
    expect(trash.map((e) => e.name)).toContain('To trim');
    await client.close();
  });

  it('refusals: read-only boards, a board-limited token, another account, viewers', async () => {
    await t.api(admin, acmeId).patch(`/boards/${secretId}`, { permission_set: 'view_comment' });
    const member = await connect(await mint(bob, acmeId, ['boards:write']));
    expect((await call(member, 'delete_column', { board_id: secretId, column_id: 'name' })).error.code).toBe(
      'forbidden',
    );
    expect((await call(member, 'delete_board', { board_id: secretId })).error.code).toBe('forbidden');
    expect((await call(member, 'create_view', { board_id: secretId, name: 'x' })).error.code).toBe('forbidden');
    await member.close();

    const limited = await connect(await mint(admin, acmeId, ['boards:write'], { board_ids: [leadsId] }));
    expect((await call(limited, 'create_workspace', { name: 'x' })).error.code).toBe('forbidden');
    expect((await call(limited, 'create_folder', { workspace_id: wsId, name: 'x' })).error.code).toBe('forbidden');
    expect((await call(limited, 'delete_board', { board_id: secretId })).error.code).toBe('not_found');
    await limited.close();

    const other = await connect(await mint(otherAdmin, otherId, ['admin']));
    expect((await call(other, 'delete_board', { board_id: leadsId })).error.code).toBe('not_found');
    expect((await call(other, 'create_folder', { workspace_id: wsId, name: 'x' })).isError).toBe(true);
    await other.close();

    await t.api(admin, acmeId).patch('/ai/settings', { mcp_roles: ['member', 'viewer'] });
    const viewer = await connect(await rawToken('carol@acme.test', acmeId, ['boards:write']));
    const seen = await toolNames(viewer);
    for (const n of ['create_workspace', 'create_folder', 'move_board', 'delete_board', 'delete_column'])
      expect(seen).not.toContain(n);
    await viewer.close();
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_roles: ['member'] });
  });
});

describe('move_item_to_board (sensitive)', () => {
  it('moves an item with its cells (automatic mapping by type + title), undoable as one call', async () => {
    const client = await connect(await mint(bob, acmeId, ['boards:read', 'items:write']));
    const item = await call(client, 'create_item', {
      board_id: leadsId,
      name: 'Moving lead',
      cells: { [statusKey]: labels[1]!.label },
    });
    const moved = await call(client, 'move_item_to_board', { item_id: item.data.id, board_id: targetId });
    expect(moved.isError, JSON.stringify(moved.error)).toBe(false);
    expect(moved.data).toMatchObject({ ok: true, item_id: item.data.id, board_id: targetId });
    const after = await call(client, 'get_item', { item_id: item.data.id });
    expect(after.data.board.id).toBe(targetId);
    const targetStatus = (await call(client, 'get_board', { board_id: targetId })).data.columns.find(
      (c: Json) => c.type === 'status',
    ).id;
    expect(after.data.cells[targetStatus].text).toBe(labels[1]!.label);
    expect((await call(client, 'undo', { batch_id: moved.data.batch_id })).isError).toBe(false);
    expect((await call(client, 'get_item', { item_id: item.data.id })).data.board.id).toBe(leadsId);

    // A bad mapping is explained, not guessed.
    const bad = await call(client, 'move_item_to_board', {
      item_id: item.data.id,
      board_id: targetId,
      mapping: { [statusKey]: 'name' },
    });
    expect(bad.error.code).toBe('invalid_value');
    await client.close();
  });

  it('refusals: a board-limited token, a read-only board, another account; hidden when sensitive tools are blocked', async () => {
    const as = t.api(admin, acmeId);
    const item = await body(await as.post(`/boards/${leadsId}/items`, { name: 'Stays' }));
    const limited = await connect(await mint(bob, acmeId, ['boards:read', 'items:write'], { board_ids: [leadsId] }));
    expect((await call(limited, 'move_item_to_board', { item_id: item.id, board_id: targetId })).error.code).toBe(
      'not_found',
    );
    await limited.close();

    const member = await connect(await mint(bob, acmeId, ['boards:read', 'items:write']));
    // secret is view_comment for members (set above).
    expect((await call(member, 'move_item_to_board', { item_id: item.id, board_id: secretId })).error.code).toBe(
      'forbidden',
    );
    await member.close();

    const other = await connect(await mint(otherAdmin, otherId, ['admin']));
    expect((await call(other, 'move_item_to_board', { item_id: item.id, board_id: targetId })).error.code).toBe(
      'not_found',
    );
    await other.close();

    await as.patch('/ai/settings', { mcp_sensitive: 'block' });
    const blocked = await connect(await mint(bob, acmeId, ['boards:read', 'items:write']));
    const names = await toolNames(blocked);
    expect(names).not.toContain('move_item_to_board');
    expect(names).not.toContain('attach_file_from_url');
    await blocked.close();
    await as.patch('/ai/settings', { mcp_sensitive: 'allow' });
  });
});

describe('files: attach_file_from_url and get_file_link', () => {
  it('downloads a public link into a file column; get_file_link gives a short signed link', async () => {
    const client = await connect(await mint(bob, acmeId, ['boards:read', 'items:write']));
    const item = await call(client, 'create_item', { board_id: leadsId, name: 'With a quote' });
    const attached = await call(client, 'attach_file_from_url', {
      item_id: item.data.id,
      column_id: filesKey,
      url: 'https://files.example.com/docs/quote.pdf',
    });
    expect(attached.isError, JSON.stringify(attached.error)).toBe(false);
    expect(attached.data).toMatchObject({ name: 'quote.pdf', mime: 'application/pdf' });
    expect((await eventsOf(attached.data.batch_id)).map((e) => e.type)).toEqual(['file.added']);
    const files = await call(client, 'list_files', { item_id: item.data.id });
    expect(files.data.files).toEqual([expect.objectContaining({ id: attached.data.id, where: `column:${filesKey}` })]);

    const link = await call(client, 'get_file_link', { file_id: attached.data.id });
    expect(link.data).toMatchObject({ id: attached.data.id, name: 'quote.pdf', expires_in_seconds: 900 });
    expect(link.data.download_url).toMatch(/^https:\/\/storage\.test\//);

    // Someone else who can read the item gets the link too; a token limited elsewhere, another account do not.
    const adminClient = await connect(await mint(admin, acmeId, ['boards:read']));
    expect((await call(adminClient, 'get_file_link', { file_id: attached.data.id })).isError).toBe(false);
    await adminClient.close();
    const limited = await connect(await mint(bob, acmeId, ['boards:read'], { board_ids: [targetId] }));
    expect((await call(limited, 'get_file_link', { file_id: attached.data.id })).error.code).toBe('not_found');
    await limited.close();
    const other = await connect(await mint(otherAdmin, otherId, ['admin']));
    expect((await call(other, 'get_file_link', { file_id: attached.data.id })).error.code).toBe('not_found');
    await other.close();
    await client.close();
  });

  it('refuses private / loopback / metadata addresses, web pages, non-file columns — and checks rights first', async () => {
    const client = await connect(await mint(bob, acmeId, ['boards:read', 'items:write']));
    const item = await call(client, 'create_item', { board_id: leadsId, name: 'No files here' });
    for (const url of [
      'http://127.0.0.1/a.pdf',
      'http://localhost:3000/a.pdf',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/a.pdf',
      'http://[::1]/a.pdf',
      'http://[::ffff:127.0.0.1]/a.pdf',
    ]) {
      const r = await call(client, 'attach_file_from_url', { item_id: item.data.id, column_id: filesKey, url });
      expect(r.isError, url).toBe(true);
      expect(r.error.code, url).toBe('invalid_value');
      expect(r.error.message, url).toMatch(/private/);
    }
    const page = await call(client, 'attach_file_from_url', {
      item_id: item.data.id,
      column_id: filesKey,
      url: 'https://files.example.com/login.html',
    });
    expect(page.error.code).toBe('invalid_value');
    expect(page.error.message).toMatch(/unsupported_file_type/);
    expect((await call(client, 'list_files', { item_id: item.data.id })).data.files).toEqual([]);

    const notFiles = await call(client, 'attach_file_from_url', {
      item_id: item.data.id,
      column_id: statusKey,
      url: 'https://files.example.com/a.pdf',
    });
    expect(notFiles.error.code).toBe('not_found');
    // Not allowed to change the item → nothing is fetched at all.
    const secretItem = (await body(await t.api(admin, acmeId).post(`/boards/${secretId}/items`, { name: 'S' }))).id;
    const before = downloads.calls.length;
    const denied = await call(client, 'attach_file_from_url', {
      item_id: secretItem,
      column_id: filesKey,
      url: 'https://files.example.com/a.pdf',
    });
    expect(denied.isError).toBe(true);
    expect(downloads.calls.length).toBe(before);
    await client.close();

    // Viewers never get it.
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_roles: ['member', 'viewer'] });
    const viewer = await connect(await rawToken('carol@acme.test', acmeId, ['items:write']));
    const names = await toolNames(viewer);
    expect(names).not.toContain('attach_file_from_url');
    expect(names).toContain('get_file_link');
    await viewer.close();
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_roles: ['member'] });
  });
});

describe('my_work', () => {
  it("lists the user's assigned items by section — only on boards the token may read", async () => {
    const client = await connect(await mint(bob, acmeId, ['boards:read', 'items:write', 'users:read']));
    const mine = await call(client, 'create_item', {
      board_id: leadsId,
      name: 'Call Dana',
      cells: { [peopleKey]: 'bob@acme.test', [statusKey]: labels[0]!.label },
    });
    expect(mine.isError, JSON.stringify(mine.error)).toBe(false);
    const work = await call(client, 'my_work');
    expect(work.isError, JSON.stringify(work.error)).toBe(false);
    const row = work.data.items.find((i: Json) => i.id === mine.data.id);
    expect(row).toMatchObject({ name: 'Call Dana', board_id: leadsId, board_name: 'Leads', section: 'no_date' });
    expect(row.status).toBe(labels[0]!.label);
    const onlyToday = await call(client, 'my_work', { sections: ['today'] });
    expect(onlyToday.data.items.find((i: Json) => i.id === mine.data.id)).toBeUndefined();
    await client.close();

    const limited = await connect(await mint(bob, acmeId, ['boards:read'], { board_ids: [targetId] }));
    expect((await call(limited, 'my_work')).data.items.find((i: Json) => i.id === mine.data.id)).toBeUndefined();
    await limited.close();
    // Admin (not assigned) does not see Bob's item as theirs.
    const adminClient = await connect(await mint(admin, acmeId, ['boards:read']));
    expect((await call(adminClient, 'my_work')).data.items.find((i: Json) => i.id === mine.data.id)).toBeUndefined();
    await adminClient.close();
  });
});

describe('test_automation and automation_runs', () => {
  it('a dry run writes nothing; runs are listed per automation and per board', async () => {
    const client = await connect(await mint(admin, acmeId, ['boards:read', 'items:write', 'automations:write']));
    const a = await call(client, 'create_automation', {
      board_id: leadsId,
      recipe: {
        trigger: { type: 'status_changed', column: statusKey, labels: [labels[1]!.label] },
        actions: [{ type: 'archive_item' }],
      },
    });
    expect(a.isError, JSON.stringify(a.error)).toBe(false);
    const item = await call(client, 'create_item', {
      board_id: leadsId,
      name: 'Test subject',
      cells: { [statusKey]: labels[1]!.label },
    });
    const needsItem = await call(client, 'test_automation', { automation_id: a.data.id });
    expect(needsItem.error.code).toBe('bad_request');
    const dry = await call(client, 'test_automation', { automation_id: a.data.id, item_id: item.data.id });
    expect(dry.isError, JSON.stringify(dry.error)).toBe(false);
    expect(dry.data.conditions.matched).toBe(true);
    expect(dry.data.actions).toEqual([expect.objectContaining({ index: 0, type: 'archive_item', would_write: true })]);
    expect(dry.data.run_id).toBeUndefined();
    // Nothing was written: the item is still on the board.
    expect((await call(client, 'get_item', { item_id: item.data.id })).isError).toBe(false);

    // A real run (from the app) shows up in the runs.
    await call(client, 'set_automation_active', { automation_id: a.data.id, is_active: true });
    const real = await body(
      await t.api(admin, acmeId).post(`/automations/${a.data.id}/test`, { item_id: item.data.id, dry_run: false }),
    );
    const byAutomation = await call(client, 'automation_runs', { automation_id: a.data.id });
    expect(byAutomation.data.runs[0]).toMatchObject({ id: real.run_id, status: 'succeeded', item_id: item.data.id });
    expect(byAutomation.data.runs[0].log).toBeUndefined();
    const withLog = await call(client, 'automation_runs', { board_id: leadsId, include_log: true });
    expect(withLog.data.runs.map((r: Json) => r.id)).toContain(real.run_id);
    expect(withLog.data.runs.find((r: Json) => r.id === real.run_id).log.length).toBeGreaterThan(0);
    const failed = await call(client, 'automation_runs', { board_id: leadsId, status: 'failed' });
    expect(failed.data.runs).toEqual([]);
    await client.close();

    // A member may read the runs but not test someone else's automation.
    const member = await connect(await mint(bob, acmeId, ['boards:read', 'automations:read']));
    expect((await call(member, 'automation_runs', { automation_id: a.data.id })).isError).toBe(false);
    const forbidden = await call(member, 'test_automation', { automation_id: a.data.id, item_id: item.data.id });
    expect(forbidden.error.code).toBe('forbidden');
    await member.close();

    const limited = await connect(await mint(admin, acmeId, ['automations:read'], { board_ids: [targetId] }));
    expect((await call(limited, 'automation_runs', { automation_id: a.data.id })).error.code).toBe('not_found');
    expect((await call(limited, 'automation_runs', { board_id: leadsId })).error.code).toBe('not_found');
    expect((await call(limited, 'test_automation', { automation_id: a.data.id })).error.code).toBe('not_found');
    await limited.close();

    const other = await connect(await mint(otherAdmin, otherId, ['admin']));
    expect((await call(other, 'automation_runs', { automation_id: a.data.id })).error.code).toBe('not_found');
    expect((await call(other, 'automation_runs', { board_id: leadsId })).error.code).toBe('not_found');
    expect((await call(other, 'test_automation', { automation_id: a.data.id })).error.code).toBe('not_found');
    await other.close();
  });
});

describe('move_item_in_hierarchy', () => {
  it('nests an item under another and back up through the hierarchy service, undoable as one call', async () => {
    const client = await connect(await mint(bob, acmeId, ['boards:read', 'items:write']));
    const parent = await call(client, 'create_item', { board_id: leadsId, name: 'Parent lead' });
    const child = await call(client, 'create_item', { board_id: leadsId, name: 'Child lead' });
    const under = await call(client, 'move_item_in_hierarchy', {
      item_id: child.data.id,
      parent_item_id: parent.data.id,
    });
    expect(under.isError, JSON.stringify(under.error)).toBe(false);
    expect(under.data).toMatchObject({ ok: true, item_id: child.data.id });
    expect((await call(client, 'get_item', { item_id: child.data.id })).data.parent_item_id).toBe(parent.data.id);
    expect((await eventsOf(under.data.batch_id)).some((e) => e.type === 'item.converted')).toBe(true);

    const up = await call(client, 'move_item_in_hierarchy', { item_id: child.data.id, level_up: true });
    expect(up.isError, JSON.stringify(up.error)).toBe(false);
    expect((await call(client, 'get_item', { item_id: child.data.id })).data.parent_item_id ?? null).toBeNull();
    expect((await call(client, 'undo', { batch_id: up.data.batch_id })).isError).toBe(false);
    expect((await call(client, 'get_item', { item_id: child.data.id })).data.parent_item_id).toBe(parent.data.id);

    // Exactly one of the two; never under itself.
    expect((await call(client, 'move_item_in_hierarchy', { item_id: child.data.id })).isError).toBe(true);
    const self = await call(client, 'move_item_in_hierarchy', {
      item_id: parent.data.id,
      parent_item_id: parent.data.id,
    });
    expect(self.isError).toBe(true);
    await client.close();
  });
});

describe("update_item_card: the item card's tabs from chat", () => {
  it('reorders, hides, renames and picks fields; get_board and the board show the same card', async () => {
    const client = await connect(await mint(admin, acmeId, ['boards:read', 'boards:write']));
    const before = await call(client, 'get_board', { board_id: leadsId });
    expect(before.data.card.tabs.map((x: Json) => x.id)).toEqual([
      'updates',
      'fields',
      'subitems',
      'time',
      'activity',
      'documents',
    ]);
    const res = await call(client, 'update_item_card', {
      board_id: leadsId,
      tabs: [
        { id: 'updates', type: 'updates', hidden: true },
        { id: 'fields', type: 'fields', title: 'פרטי ליד', columns: [statusKey, peopleKey] },
        { id: 'fields_2', type: 'fields', title: 'קבצים', columns: [filesKey] },
        { id: 'activity', type: 'activity' },
        { id: 'time', type: 'time', hidden: true },
      ],
      fields_per_row: 2,
      subitems: { in_fields: false },
    });
    expect(res.isError, JSON.stringify(res.error)).toBe(false);
    const tabs = res.data.card.tabs as Json[];
    // "updates" stays first and shown; tabs left out come back at the end with their defaults.
    expect(tabs.map((x) => [x.id, x.hidden])).toEqual([
      ['updates', false],
      ['fields', false],
      ['fields_2', false],
      ['activity', false],
      ['time', true],
      ['subitems', false],
      ['documents', false],
    ]);
    expect(tabs[1]).toMatchObject({ title: 'פרטי ליד', columns: [statusKey, peopleKey] });
    expect(res.data.card).toMatchObject({ fields_per_row: 2, subitems: { in_fields: false } });
    expect((await eventsOf(res.data.batch_id)).map((e) => e.type)).toEqual(['board.updated']);
    const board = await body(await t.api(admin, acmeId).get(`/boards/${leadsId}`));
    expect(board.card.tabs.find((x: Json) => x.id === 'fields_2').columns).toEqual([filesKey]);

    // Only fields_per_row: the tabs stay.
    const perRow = await call(client, 'update_item_card', { board_id: leadsId, fields_per_row: 'auto' });
    expect(perRow.data.card.tabs.map((x: Json) => x.id)).toEqual(tabs.map((x) => x.id));
    expect(perRow.data.card.fields_per_row).toBe('auto');
  });

  it('refuses unknown columns, an empty change, a read-only token and another account', async () => {
    const client = await connect(await mint(admin, acmeId, ['boards:read', 'boards:write']));
    const bad = await call(client, 'update_item_card', {
      board_id: leadsId,
      tabs: [{ id: 'fields', type: 'fields', columns: ['nope'] }],
    });
    expect(bad.error.code).toBe('invalid_value');
    expect((await call(client, 'update_item_card', { board_id: leadsId })).error.code).toBe('bad_request');
    const reader = await connect(await mint(admin, acmeId, ['boards:read']));
    expect(await toolNames(reader)).not.toContain('update_item_card');
    const other = await connect(await mint(otherAdmin, otherId, ['boards:read', 'boards:write']));
    expect((await call(other, 'update_item_card', { board_id: leadsId, fields_per_row: 2 })).isError).toBe(true);
  });
});

describe('set_update_task: a check box in an update from chat', () => {
  it("list_updates shows each box; another member ticks one of the admin's update", async () => {
    const item = (await body(await t.api(admin, acmeId).post(`/boards/${leadsId}/items`, { name: 'משימות' }))).id;
    const task = (text: string) => ({
      type: 'taskItem',
      attrs: { checked: false },
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const doc = { type: 'doc', content: [{ type: 'taskList', content: [task('לבדוק חוזה'), task('לשלוח')] }] };
    const u = await body(await t.api(admin, acmeId).post(`/items/${item}/updates`, { doc }));
    const client = await connect(await mint(bob, acmeId, ['updates:read', 'updates:write', 'boards:read']));
    const listed = await call(client, 'list_updates', { item_id: item });
    expect(listed.data.updates[0].tasks).toEqual([
      { index: 0, text: 'לבדוק חוזה', checked: false },
      { index: 1, text: 'לשלוח', checked: false },
    ]);
    const res = await call(client, 'set_update_task', { update_id: u.id, index: 1, checked: true });
    expect(res.isError, JSON.stringify(res.error)).toBe(false);
    expect(res.data.tasks.map((x: Json) => x.checked)).toEqual([false, true]);
    expect((await call(client, 'set_update_task', { update_id: u.id, index: 7, checked: true })).error.code).toBe(
      'not_found',
    );
  });
});
