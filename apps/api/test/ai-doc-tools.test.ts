// SPDX-License-Identifier: AGPL-3.0-only
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docs } from '../src/db/schema';
import { DOC_TOOL_TEXT_MAX } from '../src/modules/docs/docs.ai';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * The docs AI tools (`get_doc`, `search_docs`) over the MCP server: a doc's text through the docs module's own access
 * path — a doc one may not open is a 404 and never a search hit — wrapped as untrusted content, cut at ~30k characters.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let planId: string;
let privateId: string;
let longId: string;
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
  const parsed = JSON.parse(res.content[0].text);
  return { isError: !!res.isError, data: (res.structuredContent ?? parsed) as Json, error: parsed.error as Json };
};

/** A doc with this text, as the collab server would have derived it. */
const newDoc = async (cookie: string, wsId: string, input: Json, text: string) => {
  const res = await t.api(cookie, acmeId).post(`/workspaces/${wsId}/docs`, input);
  expect(res.status).toBe(201);
  const id = (await body(res)).id as string;
  await t.db.update(docs).set({ textValue: text }).where(eq(docs.id, id));
  return id;
};

let bobClient: Client;
let adminClient: Client;

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
  const wsId = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id as string;
  planId = await newDoc(
    admin,
    wsId,
    { name: 'Quarterly plan' },
    'Goals\nRevenue grows fast in the fourth quarter\nלסגור חוזה',
  );
  privateId = await newDoc(
    admin,
    wsId,
    { name: 'Hidden zebra', kind: 'private' },
    'Salaries and the zebra budget — grows fast',
  );
  longId = await newDoc(admin, wsId, { name: 'Handbook' }, 'א'.repeat(DOC_TOOL_TEXT_MAX + 500));
  bobClient = await connect(await mint(bob, ['boards:read', 'search']));
  adminClient = await connect(await mint(admin, ['boards:read', 'search']));
});
afterAll(async () => {
  await bobClient?.close();
  await adminClient?.close();
  await t.close();
});

describe('get_doc', () => {
  it('returns the title and the plain text of a doc the person can open, wrapped as untrusted content', async () => {
    const r = await call(bobClient, 'get_doc', { doc_id: planId });
    expect(r.isError, JSON.stringify(r.error)).toBe(false);
    expect(r.data).toMatchObject({ id: planId, title: 'Quarterly plan', truncated: false });
    expect(r.data.text).toContain('Revenue grows fast in the fourth quarter');
    expect(r.data.text).toContain('לסגור חוזה');
    expect(r.data.text).toMatch(/^<untrusted_content source="doc:[^"]+">/);
    expect(typeof r.data.updated_at).toBe('string');
  });

  it('is not found for a doc the person cannot open (and for no doc at all)', async () => {
    const hidden = await call(bobClient, 'get_doc', { doc_id: privateId });
    expect(hidden.isError).toBe(true);
    expect(hidden.error.code).toBe('not_found');
    expect(JSON.stringify(hidden)).not.toContain('Salaries');
    expect((await call(bobClient, 'get_doc', { doc_id: 'no-such-doc' })).error.code).toBe('not_found');
    // Its owner reads it.
    expect((await call(adminClient, 'get_doc', { doc_id: privateId })).data.title).toBe('Hidden zebra');
  });

  it('cuts a long doc at ~30k characters and says so', async () => {
    const r = await call(bobClient, 'get_doc', { doc_id: longId });
    expect(r.data.truncated).toBe(true);
    expect((r.data.text as string).split('א').length - 1).toBe(DOC_TOOL_TEXT_MAX);
  });
});

describe('search_docs', () => {
  it('finds a doc by its title and by its text, with a snippet around the match', async () => {
    const byTitle = await call(bobClient, 'search_docs', { query: 'quarterly' });
    expect(byTitle.data.docs.map((d: Json) => d.id)).toEqual([planId]);
    expect(byTitle.data.docs[0].title).toBe('Quarterly plan');
    const byText = await call(bobClient, 'search_docs', { query: 'fourth quarter' });
    expect(byText.data.docs.map((d: Json) => d.id)).toEqual([planId]);
    expect(byText.data.docs[0].snippet).toContain('Revenue grows fast in the fourth quarter');
    expect(byText.data.docs[0].snippet).toContain('<untrusted_content');
  });

  it('never returns a doc the person cannot open', async () => {
    for (const query of ['zebra', 'Salaries', 'grows fast']) {
      const r = await call(bobClient, 'search_docs', { query });
      expect(r.isError).toBe(false);
      expect(
        r.data.docs.map((d: Json) => d.id),
        query,
      ).not.toContain(privateId);
      expect(JSON.stringify(r.data), query).not.toContain('Salaries');
    }
    // Its owner finds it.
    const own = await call(adminClient, 'search_docs', { query: 'zebra' });
    expect(own.data.docs.map((d: Json) => d.id)).toEqual([privateId]);
  });

  it('keeps to the limit and keeps snippets short', async () => {
    const r = await call(adminClient, 'search_docs', { query: 'א', limit: 1 });
    expect(r.data.docs).toHaveLength(1);
    const inner = (r.data.docs[0].snippet as string).replace(/<\/?untrusted_content[^>]*>/g, '').trim();
    expect(inner.length).toBeLessThanOrEqual(300);
    // Over the max: refused by the input schema.
    const over = (await adminClient.callTool({ name: 'search_docs', arguments: { query: 'x', limit: 26 } })) as Json;
    expect(over.isError).toBe(true);
  });
});
