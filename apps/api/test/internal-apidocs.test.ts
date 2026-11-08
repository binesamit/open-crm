// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';
import { fullOpenApiDocument } from '../src/app';
import { COLLAB_MAX_MESSAGE_BYTES, COLLAB_PATH, COLLAB_RECHECK_MS } from '../src/modules/docs/collab';
import { COLLAB_DOC } from '../src/modules/apidocs/internal-guide';
import { INTERNAL_DOCS_PATH, INTERNAL_SPEC_PATH } from '../src/modules/apidocs/internal-spec';
import { operationsOf, type OpenApiDoc } from '../src/modules/apidocs/spec';
import { publicScope } from '../src/modules/apidocs/public-ops';

/** The internal API reference: the platform owner only, by session — 404 to everyone else. */
let t: TestContext;
let owner: string;
let member: string;
let memberToken: string;

const get = (path: string, headers: Record<string, string> = {}) =>
  t.app.request(path, { headers: { origin: WEB_ORIGIN, ...headers } });

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  // An account admin who is not the platform owner.
  const created = await t.api(owner).post('/platform/accounts', {
    name: 'Acme',
    slug: 'acme-intdocs',
    first_admin_email: 'admin@acme-intdocs.test',
    template_set: 'empty',
  });
  expect(created.status).toBe(201);
  const invite = t.inviteTokenFor('admin@acme-intdocs.test');
  member = t.cookieFrom(await t.signUpWithPassword('admin@acme-intdocs.test', invite))!;
  expect(member).toBeTruthy();
  expect((await t.api(member).post('/invitations/accept', { token: invite })).ok).toBe(true);
  // A personal API token: a bearer never opens the internal reference.
  const { account } = (await created.json()) as { account: { id: string } };
  const tok = await t.api(member, account.id).post('/auth/tokens', { name: 'ci', scopes: ['admin'] });
  expect(tok.ok).toBe(true);
  memberToken = ((await tok.json()) as { token: string }).token;
}, 180_000);
afterAll(() => t?.close());

describe('internal API reference — access', () => {
  for (const path of [INTERNAL_DOCS_PATH, INTERNAL_SPEC_PATH]) {
    it(`${path}: 404 signed out, 404 to a member, 404 with an API token, 200 to the owner`, async () => {
      const anon = await get(path);
      expect(anon.status).toBe(404);
      expect(await anon.text()).not.toContain('internal');
      expect((await get(path, { cookie: member })).status).toBe(404);
      expect((await get(path, { authorization: `Bearer ${memberToken}` })).status).toBe(404);
      // A bearer next to the owner's cookie does not count either: the session alone opens it.
      expect((await get(path, { cookie: owner, authorization: `Bearer ${memberToken}` })).status).toBe(404);
      const res = await get(path, { cookie: owner });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('x-robots-tag')).toContain('noindex');
    });
  }

  it('serves the page under the docs CSP, marked internal, with the shared renderer', async () => {
    const res = await get(INTERNAL_DOCS_PATH, { cookie: owner });
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    const html = await res.text();
    expect(html).toContain('Internal — subject to change');
    expect(html).toContain('/api/docs/scalar.js');
    expect(html).toContain(INTERNAL_SPEC_PATH);
    expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
  });

  it('the public page links to it only for the owner', async () => {
    expect(await (await get('/api/docs')).text()).not.toContain(INTERNAL_DOCS_PATH);
    expect(await (await get('/api/docs', { cookie: member })).text()).not.toContain(INTERNAL_DOCS_PATH);
    const own = await get('/api/docs', { cookie: owner });
    expect(own.status).toBe(200);
    expect(await own.text()).toContain(`href="${INTERNAL_DOCS_PATH}"`);
    expect(own.headers.get('cache-control')).toContain('private');
  });

  it('the public documents never carry the internal reference', async () => {
    for (const path of ['/api/docs/openapi.json', '/api/v1/openapi.json']) {
      const json = await (await get(path, { cookie: owner })).text();
      expect(json).not.toContain('x-visibility');
      expect(json).not.toContain('/platform/accounts');
    }
  });
});

describe('internal API reference — the document', () => {
  let doc: OpenApiDoc;
  beforeAll(async () => {
    doc = (await (await get(INTERNAL_SPEC_PATH, { cookie: owner })).json()) as OpenApiDoc;
  });

  it('lists every operation, labelled public or internal like the public reference decides', () => {
    const full = fullOpenApiDocument(t.app);
    const ops = operationsOf(doc);
    expect(ops.length).toBe(operationsOf(full).length);
    const wrong = ops.filter(
      ({ method, path, op }) => op['x-visibility'] !== (publicScope(method, path) === false ? 'internal' : 'public'),
    );
    expect(wrong.map((o) => `${o.method} ${o.path}`)).toEqual([]);
    expect(ops.filter((o) => o.op['x-visibility'] === 'internal').length).toBeGreaterThan(150);
  });

  it('shows method, path, access and a summary on every operation', () => {
    const missing: string[] = [];
    for (const { method, path, op } of operationsOf(doc)) {
      if (!op.summary?.trim()) missing.push(`${method} ${path}: summary`);
      if (!op.description?.includes(`${method.toUpperCase()} /api/v1${path}`)) missing.push(`${method} ${path}: path`);
      if (!op.description?.includes('**Access:**')) missing.push(`${method} ${path}: access`);
      if (!Array.isArray(op['x-badges'])) missing.push(`${method} ${path}: badge`);
    }
    expect(missing).toEqual([]);
  });

  it('labels the owner console and the support console', () => {
    const owner = doc.paths['/platform/accounts']!.get!;
    expect(owner['x-access']).toBe('owner');
    expect(owner.description).toContain('Platform owner only');
    expect(owner.tags).toEqual(['platform · accounts']);
    expect(doc.paths['/platform/support/tickets']!.get!['x-access']).toBe('support-console');
    expect(doc.paths['/auth/tokens']!.get!['x-access']).toBe('session');
    expect(doc.paths['/health']!.get!['x-access']).toBe('none');
  });

  it('groups by module, the owner console by area', () => {
    const groups = doc['x-tagGroups'] as { name: string; tags: string[] }[];
    const console = groups.find((g) => g.name.startsWith('Owner console'))!;
    expect(console.tags).toEqual(expect.arrayContaining(['platform · accounts', 'platform · support']));
    const listed = new Set(groups.flatMap((g) => g.tags));
    const used = new Set(operationsOf(doc).flatMap(({ op }) => op.tags ?? []));
    expect([...used].filter((tag) => !listed.has(tag))).toEqual([]);
  });

  it('documents the channels outside the document: MCP, the docs WebSocket, Better Auth', () => {
    const text = String(doc.info.description);
    expect(String(doc.info.title)).toContain('subject to change');
    for (const s of ['# MCP server', '# Docs collaboration WebSocket', '# Sign-in (Better Auth)', '/mcp', '/api/auth'])
      expect(text).toContain(s);
    expect(text).toContain(COLLAB_PATH);
    expect(COLLAB_DOC.path).toBe(COLLAB_PATH);
    expect(COLLAB_DOC.recheckS * 1000).toBe(COLLAB_RECHECK_MS);
    expect(COLLAB_DOC.maxMessageBytes).toBe(COLLAB_MAX_MESSAGE_BYTES);
  });

  it('describes the key owner-console, extensions and support operations', () => {
    const keys: [string, string][] = [
      ['/platform/accounts', 'post'],
      ['/platform/accounts/{id}/suspend', 'post'],
      ['/platform/settings', 'patch'],
      ['/extensions/install', 'post'],
      ['/platform/extensions/kill', 'post'],
      ['/platform/support/tickets', 'get'],
      ['/support-access', 'post'],
    ];
    for (const [path, method] of keys) {
      const own = fullOpenApiDocument(t.app).paths[path]?.[method as 'get']?.description;
      expect(own?.trim().length, `${method} ${path}`).toBeGreaterThan(40);
    }
  });
});
