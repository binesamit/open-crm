// SPDX-License-Identifier: AGPL-3.0-only
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toursOfContent } from '../src/modules/ai2/assistant.service';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Product knowledge for AI: search_help / get_help_article read the help center as the person may
 * (plus the owner's AI-only articles, which people never see), show_me offers a published tour, whoami says what the
 * plan leaves out, and an AI app gets the owner's guide category as the `bines://guide` resource.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let wsId: string;
let leadsId: string;
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
});
afterAll(() => t.close());

let owner: string;
const doc = (...paras: string[]) => ({
  type: 'doc',
  content: paras.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
});
const article = async (input: Json) => {
  const res = await t.api(owner).post('/platform/support/help/articles', input);
  const a = await body(res);
  expect(res.status, JSON.stringify(a)).toBe(201);
  expect((await t.api(owner).post(`/platform/support/help/articles/${a.id}/publish`)).status).toBe(200);
  return a;
};

describe('product knowledge for AI', () => {
  let tourId: string;
  let catId: string;
  it('search_help / get_help_article read the help center; AI-only articles are for the AI, never for people', async () => {
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    const tour = await body(
      await t.api(owner).post('/platform/support/help/tours', {
        title: 'Mirror column tour',
        route: 'board',
        steps: [{ id: 'a', anchor: 'board.add-column', title: 'Add a column', body: 'Pick "Mirror"' }],
      }),
    );
    tourId = tour.id;
    await t.api(owner).patch(`/platform/support/help/tours/${tourId}`, { status: 'published' });
    const cats = await body(
      await t.api(owner).post('/platform/support/help/categories', { name: 'Start', icon: 'board' }),
    );
    catId = (cats.categories as Json[]).find((c) => c.name === 'Start')!.id;
    await article({
      title: 'Mirror columns',
      locale: 'en',
      category_id: catId,
      content: doc('A mirror column shows a value of a linked item.', 'Add it from the column menu.'),
      tour_id: tourId,
    });
    await article({
      title: 'Internal: how support explains mirrors',
      locale: 'en',
      tags: ['ai'],
      content: doc('Tell people that mirror columns follow the linked board automatically.'),
    });
    expect(
      (await t.api(owner).patch('/platform/support/help/settings', { ai_knowledge: { ai_only_tag: 'ai' } })).status,
    ).toBe(200);
    // People: the AI-only article is not there.
    const people = await body(await t.api(admin, acmeId).get('/support/help/search?q=mirror'));
    expect((people.data as Json[]).map((x) => x.title)).toEqual(['Mirror columns']);
    // The AI (MCP, any token): both.
    const client = await connect(await mint(bob, ['boards:read']));
    const found = await call(client, 'search_help', { query: 'mirror' });
    expect(found.isError, JSON.stringify(found.error)).toBe(false);
    expect((found.data.data as Json[]).map((x) => x.title).sort()).toEqual(
      ['Internal: how support explains mirrors', 'Mirror columns'].sort(),
    );
    const first = (found.data.data as Json[]).find((x) => x.title === 'Mirror columns')!;
    const full = await call(client, 'get_help_article', { article: first.id });
    expect(full.data).toMatchObject({ title: 'Mirror columns', tour_id: tourId });
    expect(full.data.text).toContain('linked item');
    const shown = await call(client, 'show_me', { tour_id: tourId });
    expect(shown.data).toMatchObject({ tour_id: tourId, title: 'Mirror column tour' });
    expect(shown.data.steps[0]).toContain('Add a column');
    await client.close();
  });

  it('whoami says what the plan leaves out; an AI app gets the guide category as a resource', async () => {
    const plan = await body(
      await t.api(owner).post('/platform/plans', { name: 'Small', version: { features: ['api', 'ai'] } }),
    );
    await t.api(owner).put(`/platform/accounts/${acmeId}/subscription`, { plan_version_id: plan.versions[0].id });
    const client = await connect(await mint(admin, ['boards:read']));
    const me = await call(client, 'whoami', {});
    expect(me.data.missing_features).toContain('dashboards');
    expect(me.data.missing_features).not.toContain('ai');
    const none = await client.readResource({ uri: 'bines://guide' });
    expect((none.contents[0] as Json).text).toContain('search_help');
    await t.api(owner).patch('/platform/support/help/settings', { ai_knowledge: { guide_category_id: catId } });
    const guide = await client.readResource({ uri: 'bines://guide' });
    expect((guide.contents[0] as Json).text).toContain('# Mirror columns');
    await client.close();
  });

  it('the assistant’s "show me" buttons come from its show_me calls in the stored turn', () => {
    const content = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'show_me', input: { tour_id: 'T1' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: JSON.stringify({ tour_id: 'T1', title: 'Tour one' }) },
          { type: 'tool_result', tool_use_id: 'other', content: JSON.stringify({ tour_id: 'T2', title: 'Not one' }) },
        ],
      },
    ];
    expect(toursOfContent(content)).toEqual([{ id: 'T1', title: 'Tour one' }]);
  });
});
