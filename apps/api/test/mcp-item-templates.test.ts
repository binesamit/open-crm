// SPDX-License-Identifier: AGPL-3.0-only
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Item templates for AI: list / get read; create (from an item or a described tree), update, apply and
 * delete go through the same service as the app — the token's scopes, the board's rights, a tree checked in full, and
 * one undoable batch per call.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let boardId: string;
let itemId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const mint = async (scopes: string[]) =>
  (await body(await t.api(admin, acmeId).post('/auth/tokens', { name: 'Claude Code', scopes }))).token as string;
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
const as = () => t.api(admin, acmeId);

const TREE = {
  id: 'root',
  name: 'פרויקט {client}',
  cells: { due: { kind: 'date', var: 'start', from: 0 } },
  updates: [{ text: 'נפתח עבור {client}' }],
  children: [
    {
      id: 'a',
      name: 'אפיון',
      cells: { date: { kind: 'date', var: 'start', from: 3 } },
      children: [{ id: 'a1', name: 'שאלון' }],
    },
    { id: 'b', name: 'מסירה ל{client}' },
  ],
};
const VARS = [
  { key: 'client', label: 'לקוח', type: 'text', required: true },
  { key: 'start', label: 'התחלה', type: 'date', default: 'today' },
];

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
  const ws = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Projects', workspace_id: ws }))).id;
  await as().post(`/boards/${boardId}/columns`, { id: 'due', title: 'יעד', type: 'date' });
  itemId = (await body(await as().post(`/boards/${boardId}/items`, { name: 'Existing' }))).id;
  await as().post(`/items/${itemId}/subitems`, { name: 'step' });
});
afterAll(() => t.close());

describe('item template tools', () => {
  let templateId: string;

  it('a read token lists and reads, but cannot make one', async () => {
    const client = await connect(await mint(['boards:read']));
    expect((await call(client, 'list_item_templates', { board_id: boardId })).data.templates).toEqual([]);
    // Write tools are not even offered to a read token.
    const offered = (await client.listTools()).tools.map((x) => x.name);
    expect(offered).toContain('get_item_template');
    expect(offered).not.toContain('create_item_template');
    expect(offered).not.toContain('apply_item_template');
    await client.close();
  });

  it('makes a template from a described tree (checked in full), and from an item', async () => {
    const client = await connect(await mint(['boards:read', 'boards:write', 'items:write']));
    const bad = await call(client, 'create_item_template', {
      name: 'x',
      board_id: boardId,
      root: { id: 'r', name: 'x', cells: { due: { kind: 'nonsense' } } },
    });
    expect(bad.isError).toBe(true);
    expect(bad.error.code).toBe('validation_failed');
    const made = await call(client, 'create_item_template', {
      name: 'פרויקט',
      board_id: boardId,
      root: TREE,
      variables: VARS,
    });
    expect(made.isError, JSON.stringify(made.error)).toBe(false);
    expect(made.data).toMatchObject({ name: 'פרויקט', nodes: 4, depth: 2, version: 1 });
    templateId = made.data.id;
    const saved = await call(client, 'create_item_template', { name: 'מקיים', item_id: itemId });
    expect(saved.data).toMatchObject({ nodes: 2, depth: 1 });
    const one = await call(client, 'get_item_template', { template_id: templateId });
    expect(one.data.root.children[0].children[0].name).toBe('שאלון');
    await client.close();
  });

  it('applies it with variables (one batch), and undo trashes the whole tree', async () => {
    const client = await connect(await mint(['boards:read', 'boards:write', 'items:write']));
    const missing = await call(client, 'apply_item_template', { template_id: templateId });
    expect(missing.isError).toBe(true);
    const applied = await call(client, 'apply_item_template', {
      template_id: templateId,
      variables: { client: 'בטא', start: '2026-11-16' },
    });
    expect(applied.isError, JSON.stringify(applied.error)).toBe(false);
    expect(applied.data.created).toBe(4);
    const made = await body(await as().get(`/items/${applied.data.item_id}`));
    expect(made.name).toBe('פרויקט בטא');
    expect(made.cells.due.value).toEqual({ date: '2026-11-16' });
    const kids = (await body(await as().get(`/items/${applied.data.item_id}/subitems`))).data as Json[];
    expect(kids.map((k) => k.name)).toEqual(['אפיון', 'מסירה לבטא']);
    expect(kids[0]!.cells.date.value).toEqual({ date: '2026-11-19' });
    const undone = await call(client, 'undo', { batch_id: applied.data.batch_id });
    expect(undone.isError, JSON.stringify(undone.error)).toBe(false);
    expect((await as().get(`/items/${applied.data.item_id}`)).status).toBe(404);
    await client.close();
  });

  it('update is a new version that undo takes back; delete is undone too', async () => {
    const client = await connect(await mint(['boards:read', 'boards:write', 'items:write']));
    const changed = await call(client, 'update_item_template', {
      template_id: templateId,
      root: { ...TREE, children: [] },
    });
    expect(changed.data).toMatchObject({ version: 2, nodes: 1 });
    await call(client, 'undo', { batch_id: changed.data.batch_id });
    expect((await body(await as().get(`/item-templates/${templateId}`))).nodes).toBe(4);
    const deleted = await call(client, 'delete_item_template', { template_id: templateId });
    expect(deleted.isError, JSON.stringify(deleted.error)).toBe(false);
    expect((await as().get(`/item-templates/${templateId}`)).status).toBe(404);
    await call(client, 'undo', { batch_id: deleted.data.batch_id });
    expect((await as().get(`/item-templates/${templateId}`)).status).toBe(200);
    await client.close();
  });
});
