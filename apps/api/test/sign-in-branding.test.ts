// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { t as i18n } from '@bines/shared';
import { mcpSessionUser } from '../src/modules/mcp/mcp.auth';
import { brandIndexHtml } from '../src/web';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * s37generic — the last fixed spots made settings / per-person:
 * - the sign-in screen's tagline and the product name: owner console → GET /auth/config, per language;
 * - the served page's <title> (and iOS app title) = the product name, never a literal in index.html;
 * - an MCP session runs in its person's language (a service identity / an unknown language: the account's);
 * - a doc export's direction and language follow the doc (else the reader's language), never fixed RTL Hebrew.
 */
let t: TestContext;
let owner: string;
let admin: string;
let acmeId: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

beforeAll(async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'bines-s37-'));
  writeFileSync(
    joinPath(dir, 'index.html'),
    '<html><head><title></title><meta name="apple-mobile-web-app-title" content="" /></head><body>spa</body></html>',
  );
  t = await createTestContext({ webDistDir: dir });
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id as string;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  expect((await t.api(admin).post('/invitations/accept', { token })).status).toBe(200);
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

describe('sign-in branding (owner console)', () => {
  it('defaults: the catalog product name, no tagline', async () => {
    const res = await t.app.request('/api/v1/auth/config');
    expect(res.status).toBe(200);
    const c = await body(res);
    expect(c.branding).toEqual({
      product_name: { he: i18n('app.name', undefined, 'he'), en: i18n('app.name', undefined, 'en') },
      login_subtitle: { he: null, en: null },
    });
    expect(typeof c.google).toBe('boolean');
  });

  it('the owner sets the product name and a tagline per language; null clears one', async () => {
    const saved = await t.api(owner).patch('/platform/settings', {
      product_name: 'WorkHub',
      login_subtitle: { he: 'מערכת העבודה שלנו', en: 'Our work platform' },
    });
    expect(saved.status).toBe(200);
    expect((await body(saved)).settings.login_subtitle).toEqual({ he: 'מערכת העבודה שלנו', en: 'Our work platform' });
    let c = await body(await t.app.request('/api/v1/auth/config'));
    expect(c.branding).toEqual({
      product_name: { he: 'WorkHub', en: 'WorkHub' },
      login_subtitle: { he: 'מערכת העבודה שלנו', en: 'Our work platform' },
    });

    await t.api(owner).patch('/platform/settings', { login_subtitle: { en: null } });
    c = await body(await t.app.request('/api/v1/auth/config'));
    expect(c.branding.login_subtitle).toEqual({ he: 'מערכת העבודה שלנו', en: null });
    // Only the owner changes it.
    expect((await t.api(admin).patch('/platform/settings', { login_subtitle: { he: 'x' } })).status).toBe(404);
  });

  it('the served page carries the product name as its title (escaped), at "/" and on client routes', async () => {
    await t.api(owner).patch('/platform/settings', { product_name: 'Work <Hub>', pwa: { app_name: 'Hub' } });
    for (const path of ['/', '/index.html', '/a/acme/b/1']) {
      const html = await (await t.app.request(path)).text();
      expect(html, path).toContain('<title>Work &lt;Hub&gt;</title>');
      expect(html, path).toContain('<meta name="apple-mobile-web-app-title" content="Hub" />');
    }
    await t.api(owner).patch('/platform/settings', { product_name: null, pwa: { app_name: null } });
    const html = await (await t.app.request('/', { headers: { 'accept-language': 'en-US,en;q=0.9' } })).text();
    expect(html).toContain(`<title>${i18n('app.name', undefined, 'en')}</title>`);
    expect(brandIndexHtml('<title>x</title>', null)).toBe('<title>x</title>');
  });
});

describe('MCP session language', () => {
  const person = { id: 'u1', email: 'p@acme.test', name: 'P', emailVerified: true };

  it("is the person's own language, and their own zone", async () => {
    const u = await mcpSessionUser(t.deps, acmeId, { ...person, locale: 'en', timezone: 'Europe/London' });
    expect(u).toMatchObject({ locale: 'en', timezone: 'Europe/London', isPlatformOwner: false });
    expect((await mcpSessionUser(t.deps, acmeId, { ...person, locale: 'he' })).locale).toBe('he');
  });

  it("falls back to the account's language (a service identity, an unknown language)", async () => {
    expect((await as(admin).patch('/accounts/me', { settings: { locale: { language: 'en' } } })).status).toBe(200);
    expect((await mcpSessionUser(t.deps, acmeId, { ...person, locale: 'fr' })).locale).toBe('en');
    const svc = await mcpSessionUser(t.deps, acmeId, {
      ...person,
      locale: 'he',
      timezone: 'Asia/Jerusalem',
      isService: true,
    });
    expect(svc).toMatchObject({ locale: 'en', timezone: null, isService: true });
    await as(admin).patch('/accounts/me', { settings: { locale: { language: 'he' } } });
    expect((await mcpSessionUser(t.deps, acmeId, { ...person, locale: null })).locale).toBe('he');
  });
});

describe('doc export direction', () => {
  const newDoc = async (name: string, text?: string) => {
    const res = await as(admin).post(`/workspaces/${wsId}/docs`, { name });
    expect(res.status).toBe(201);
    const id = (await body(res)).id as string;
    if (text) {
      const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
      await t.db.execute(sql`update docs set content = ${JSON.stringify(content)}::jsonb where id = ${id}`);
    }
    return id;
  };
  const exported = async (id: string) => (await as(admin).get(`/docs/${id}/export?format=html`)).text();

  it("follows the doc's text: an English doc is ltr / en, a Hebrew one rtl / he", async () => {
    expect(await exported(await newDoc('Spec', 'Hello world'))).toContain('<html lang="en" dir="ltr">');
    expect(await exported(await newDoc('Spec', 'שלום עולם'))).toContain('<html lang="he" dir="rtl">');
    // No text: the title decides.
    expect(await exported(await newDoc('Quarterly plan'))).toContain('<html lang="en" dir="ltr">');
  });

  it("with no letters at all, the reader's language", async () => {
    const id = await newDoc('2026', '123');
    expect(await exported(id)).toContain('<html lang="he" dir="rtl">');
    const me = (await body(await t.api(admin).get('/auth/me'))).user.id as string;
    await t.db.execute(sql`update users set locale = 'en' where id = ${me}`);
    try {
      expect(await exported(id)).toContain('<html lang="en" dir="ltr">');
    } finally {
      await t.db.execute(sql`update users set locale = 'he' where id = ${me}`);
    }
  });
});
