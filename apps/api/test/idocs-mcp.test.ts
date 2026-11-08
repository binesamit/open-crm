// SPDX-License-Identifier: AGPL-3.0-only
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { eq } from 'drizzle-orm';
import { newId } from '@bines/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiTokens, users } from '../src/db/schema';
import { hashToken } from '../src/modules/tokens/tokens.service';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Interactive documents over MCP (product owner: "the document must work with MCP / AI, documented"): the
 * registry's idocs tools for an external client — listing by scope, templates, making a document from a template,
 * reading it (rows, totals), its link, sending, the log, the signature evidence and the link actions — through the
 * same service as the app: a read-only token sees no write tools, a viewer cannot make one, another account sees none.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let betaId: string;
let betaAdmin: string;
let boardId: string;
let itemId: string;
let templateId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const mint = async (cookie: string, accountId: string, scopes: string[]) =>
  (await body(await t.api(cookie, accountId).post('/auth/tokens', { name: 'Claude Code', scopes }))).token as string;
/** A viewer cannot mint a token in the app; the token row is made directly (as the other MCP suites do). */
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

const IDOC_TOOLS = [
  'list_idoc_templates',
  'list_item_idocs',
  'get_idoc',
  'create_idoc',
  'send_idoc',
  'get_idoc_link',
  'set_idoc_link',
  'get_idoc_events',
  'get_idoc_signature',
  'get_idoc_pdf',
];

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (await body(await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email }))).account
      .id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  await join('vera@acme.test');
  betaId = await mk('Beta', 'beta', 'admin@beta.test');
  betaAdmin = await join('admin@beta.test');
  const api = t.api(admin, acmeId);
  const ws = (await body(await api.get('/workspaces'))).data[0].id;
  boardId = (await body(await api.post('/boards', { name: 'הצעות', workspace_id: ws }))).id;
  await api.post(`/boards/${boardId}/columns`, { id: 'mail', title: 'מייל', type: 'email' });
  itemId = (await body(await api.post(`/boards/${boardId}/items`, { name: 'הצעה 7' }))).id;
  await api.patch(`/items/${itemId}`, { cells: { mail: { email: 'client@example.test' } } });
  const base = (await body(await api.post(`/items/${itemId}/subitems`, { name: 'חבילת בסיס' }))).id;
  const sub = (await body(await api.get(`/boards/${boardId}`))).subitems_board_id;
  await api.post(`/boards/${sub}/columns`, { id: 'price', title: 'מחיר', type: 'numbers' });
  await api.patch(`/items/${base}`, { cells: { price: 5000 } });
  const tpl = await body(
    await api.post('/idoc-templates', { name: 'הצעת מחיר', starter: 'selection_form', board_id: boardId }),
  );
  templateId = tpl.id;
  await api.patch(`/idoc-templates/${templateId}`, {
    sections: (tpl.sections as Json[]).map((s) =>
      s.kind === 'lines' ? { ...s, mode: 'fixed', mapping: { ...s.mapping, price: 'price' } } : s,
    ),
    settings: { ...tpl.settings, contact_email_column_key: 'mail' },
  });
});
afterAll(() => t.close());

describe('interactive documents over MCP', () => {
  it('lists the document tools by scope: a read-only token gets only the read ones', async () => {
    const write = await connect(await mint(admin, acmeId, ['boards:read', 'items:write']));
    expect(await toolNames(write)).toEqual(expect.arrayContaining(IDOC_TOOLS));
    const tool = (await write.listTools()).tools.find((x) => x.name === 'create_idoc')!;
    expect(tool.description).toMatch(/template/i);
    expect(Object.keys((tool.inputSchema as Json).properties)).toEqual(
      expect.arrayContaining(['item_id', 'template_id', 'starter']),
    );
    const read = await connect(await mint(admin, acmeId, ['boards:read']));
    const names = await toolNames(read);
    expect(names).toEqual(expect.arrayContaining(['list_item_idocs', 'get_idoc', 'get_idoc_link', 'get_idoc_events']));
    for (const w of ['create_idoc', 'send_idoc', 'set_idoc_link']) expect(names).not.toContain(w);
  });

  it('makes a document from a template, reads its rows and totals, its link, sends it, closes and reopens it', async () => {
    const mcp = await connect(await mint(admin, acmeId, ['boards:read', 'items:write']));
    const templates = await call(mcp, 'list_idoc_templates', { board_id: boardId });
    expect(templates.data.templates.map((x: Json) => x.id)).toContain(templateId);

    const made = await call(mcp, 'create_idoc', { item_id: itemId, template_id: templateId });
    expect(made.isError).toBe(false);
    expect(made.data).toMatchObject({ item_id: itemId, status: 'draft' });
    expect(made.data.url).toMatch(/\/p\/[a-z0-9]{32}$/);
    const docId = made.data.id as string;

    const read = await call(mcp, 'get_idoc', { doc_id: docId });
    expect(read.data.totals).toMatchObject({ currency: 'ILS', one_time: 5000, vat: 900, grand_total: 5900 });
    expect(read.data.rows[0].rows[0]).toMatchObject({ name: 'חבילת בסיס', chosen: true, one_time: 5000 });
    expect(read.data.summary.join(' ')).toContain('חבילת בסיס');

    const link = await call(mcp, 'get_idoc_link', { doc_id: docId });
    expect(link.data).toMatchObject({ url: made.data.url, state: 'active' });

    const sent = await call(mcp, 'send_idoc', { doc_id: docId });
    expect(sent.data).toMatchObject({ status: 'sent', sent_to: 'client@example.test' });
    expect(t.lastMailTo('client@example.test').text).toContain(made.data.url);

    // The client signs on the public page; the evidence is readable over MCP.
    const token = (made.data.url as string).split('/p/')[1]!;
    const page = await body(await t.app.request(`/api/v1/public/idocs/${token}`, { headers: { origin: WEB_ORIGIN } }));
    const sign = page.sections.find((s: Json) => s.kind === 'signature');
    const signed = await t.app.request(`/api/v1/public/idocs/${token}/sign`, {
      method: 'POST',
      headers: { origin: WEB_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ section_id: sign.id, name: 'Dana Client', consents: [], version: page.version }),
    });
    expect(signed.status).toBe(200);
    const docs = await call(mcp, 'list_item_idocs', { item_id: itemId });
    const signature = docs.data.documents[0].signature;
    expect(signature).toMatchObject({ name: 'Dana Client' });
    const cert = await call(mcp, 'get_idoc_signature', { signature_id: signature.id });
    expect(cert.data.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cert.data.evidence.signer.name).toBe('Dana Client');
    expect(cert.data).not.toHaveProperty('drawing');
    // The signed PDF as a short-lived link (the bytes are kept under one key per document).
    const pdf = await call(mcp, 'get_idoc_pdf', { doc_id: docId });
    expect(pdf.isError).toBe(false);
    expect(pdf.data).toMatchObject({ signed: true, expires_in_seconds: 600 });
    expect(pdf.data.file_name).toMatch(/-signed\.pdf$/);
    expect(pdf.data.download_url).toMatch(/^https?:\/\//);

    const events = await call(mcp, 'get_idoc_events', { doc_id: docId });
    expect(events.data.events.map((e: Json) => e.kind)).toEqual(
      expect.arrayContaining(['created', 'sent', 'opened', 'signed']),
    );

    const reopened = await call(mcp, 'set_idoc_link', { doc_id: docId, action: 'reopen' });
    expect(reopened.data).toMatchObject({ status: 'sent', version: 2 });
    const closed = await call(mcp, 'set_idoc_link', { doc_id: docId, action: 'close' });
    expect(closed.data.status).toBe('revoked');
    expect((await call(mcp, 'get_idoc_link', { doc_id: docId })).data.state).toBe('closed');
    const replaced = await call(mcp, 'set_idoc_link', { doc_id: docId, action: 'replace' });
    expect(replaced.data.url).not.toBe(made.data.url);
  });

  it('keeps the app rights: a viewer cannot make a document, another account sees none', async () => {
    // Viewers reach MCP only when an admin allows it (AI settings); then they only read.
    expect((await t.api(admin, acmeId).patch('/ai/settings', { mcp_roles: ['member', 'viewer'] })).status).toBe(200);
    const viewer = await connect(await rawToken('vera@acme.test', acmeId, ['boards:read']));
    expect(await toolNames(viewer)).not.toContain('create_idoc');
    const docs = await call(viewer, 'list_item_idocs', { item_id: itemId });
    expect(docs.data.documents.length).toBeGreaterThan(0);
    // A viewer may not edit the item: no client link.
    expect(docs.data.documents[0].url).toBeNull();

    const other = await connect(await mint(betaAdmin, betaId, ['boards:read', 'items:write']));
    const theirs = await call(other, 'list_item_idocs', { item_id: itemId });
    expect(theirs.isError).toBe(true);
    const make = await call(other, 'create_idoc', { item_id: itemId, template_id: templateId });
    expect(make.isError).toBe(true);
  });
});
