// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { EXTENSION_GUIDE_MD, EXTENSION_QUICKSTART_MD } from '../src/modules/apidocs/extension-docs.generated';
import { extDocLink, renderExtDocPage } from '../src/modules/apidocs/extension-docs';
import { readDoc } from '../scripts/gen-extension-docs';
import type { OpenApiDoc } from '../src/modules/apidocs/spec';

/** s37docs: the extension developer guide on the public docs site. */
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());

describe('extension developer docs — bundled Markdown', () => {
  it('is in sync with docs/extensions (run `pnpm --filter @bines/api docs:extensions` after editing them)', () => {
    expect(EXTENSION_GUIDE_MD).toBe(readDoc('README.md'));
    expect(EXTENSION_QUICKSTART_MD).toBe(readDoc('QUICKSTART.md'));
  });

  it('links the two pages to each other and drops repository paths', () => {
    expect(extDocLink('QUICKSTART.md')).toBe('/api/docs/extensions/quickstart');
    expect(extDocLink('README.md#7-the-page-sdk--binesext-sdk')).toBe(
      '/api/docs/extensions#7-the-page-sdk--binesext-sdk',
    );
    expect(extDocLink('#limits')).toBe('#limits');
    expect(extDocLink('../plans/MARKETPLACE.md')).toBeNull();
    expect(extDocLink('javascript:alert(1)')).toBeNull();
  });
});

describe('extension developer docs — the pages', () => {
  it('serves the guide and the quickstart without any script, under their own strict CSP', async () => {
    for (const [path, heading] of [
      ['/api/docs/extensions', 'extensions — developer guide'],
      ['/api/docs/extensions/quickstart', 'Quickstart — build your first'],
    ] as const) {
      const res = await t.app.request(path);
      expect(res.status, path).toBe(200);
      const csp = res.headers.get('content-security-policy')!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).not.toContain('script-src');
      const html = await res.text();
      expect(html).toContain(heading);
      expect(html).not.toMatch(/<script/i);
      expect(html).toContain('href="/api/docs/extensions.css"');
      // The navigation: the API reference and both pages, the current one marked.
      expect(html).toContain('<a href="/api/docs">API reference</a>');
      expect(html).toContain(`<a href="${path}" aria-current="page">`);
    }
    const css = await t.app.request('/api/docs/extensions.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('renders the Markdown: anchors, cross-page links, tables and code', async () => {
    const html = await (await t.app.request('/api/docs/extensions')).text();
    expect(html).toContain('id="7-the-page-sdk--binesext-sdk"');
    expect(html).toContain('href="#7-the-page-sdk--binesext-sdk"');
    expect(html).toContain('href="/api/docs/extensions/quickstart"');
    expect(html).toContain('<table>');
    expect(html).toContain('createBinesSdk');
    // A repository path is shown as text, not as a broken link.
    expect(html).not.toMatch(/href="[^"]*\.md/);
  });

  it("is white-label: the product name in prose and the deployment's origin in the examples", async () => {
    const page = renderExtDocPage('/api/docs/extensions', {
      productName: 'Acme Work',
      origin: 'https://work.acme.example',
    })!;
    expect(page).toContain('<title>Acme Work extensions — developer guide · Acme Work</title>');
    expect(page).toContain('https://work.acme.example/api/v1');
    expect(page).not.toContain('bines.example.com');
    // Code keeps its real names.
    expect(page).toContain('@bines/ext-sdk');
    expect(page).toContain('x-bines-signature');
    expect(renderExtDocPage('/api/docs/extensions/nope', { productName: 'X', origin: 'https://x.example' })).toBeNull();
  });

  it('keeps a product name that contains "Bines" as it is', () => {
    const page = renderExtDocPage('/api/docs/extensions', { productName: 'Bines OS', origin: 'https://os.example' })!;
    expect(page).toContain('<title>Bines OS extensions — developer guide · Bines OS</title>');
    expect(page).not.toContain('Bines OS OS');
  });

  it("follows the owner's product name", async () => {
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    expect((await t.api(owner).patch('/platform/settings', { product_name: 'Acme Work' })).status).toBe(200);
    try {
      const html = await (await t.app.request('/api/docs/extensions/quickstart')).text();
      expect(html).toContain('Acme Work developers');
      expect(html).toContain('build your first Acme Work extension');
    } finally {
      await t.api(owner).patch('/platform/settings', { product_name: null });
    }
  });

  it('is linked from the API reference guide', async () => {
    const doc = (await (await t.app.request('/api/docs/openapi.json')).json()) as OpenApiDoc;
    const md = String(doc.info.description);
    expect(md).toMatch(/\[Extensions developer guide\]\(https?:\/\/[^)]+\/api\/docs\/extensions\)/);
    expect(md).toMatch(/\[Quickstart\]\(https?:\/\/[^)]+\/api\/docs\/extensions\/quickstart\)/);
  });
});

/** s37market: the same guide inside the app — JSON for whoever may manage extensions in the account. */
describe('extension developer docs — in the app (GET /extensions/docs/{page})', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = any;
  const join = async (email: string) => {
    const token = t.inviteTokenFor(email);
    const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
    await t.api(cookie).post('/invitations/accept', { token });
    return cookie;
  };
  let accountId: string;
  let admin: string;
  let member: string;
  let owner: string;
  beforeAll(async () => {
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    const res = await t.api(owner).post('/platform/accounts', {
      name: 'Docs Co',
      slug: 'docs-co',
      first_admin_email: 'admin@docs-co.test',
      template_set: 'empty',
    });
    accountId = ((await res.json()) as Json).account.id;
    admin = await join('admin@docs-co.test');
    await t.api(admin, accountId).post('/users/invite', { emails: ['mem@docs-co.test'], role: 'member' });
    member = await join('mem@docs-co.test');
  });

  it('returns the guide and the quickstart: title, safe HTML, headings and the public path', async () => {
    const guide = (await (await t.api(admin, accountId).get('/extensions/docs/guide')).json()) as Json;
    expect(guide.page).toBe('guide');
    expect(guide.title).toContain('extensions — developer guide');
    expect(guide.public_path).toBe('/api/docs/extensions');
    expect(guide.html).toContain('id="7-the-page-sdk--binesext-sdk"');
    expect(guide.html).toContain('<pre><code');
    expect(guide.html).toContain('href="/api/docs/extensions/quickstart"');
    expect(guide.html).not.toMatch(/<script/i);
    expect(guide.headings.some((h: Json) => h.depth === 2 && h.id === '7-the-page-sdk--binesext-sdk')).toBe(true);
    expect(typeof guide.product_name).toBe('string');

    const quick = (await (await t.api(admin, accountId).get('/extensions/docs/quickstart')).json()) as Json;
    expect(quick.page).toBe('quickstart');
    expect(quick.title).toContain('Quickstart');
    expect(quick.public_path).toBe('/api/docs/extensions/quickstart');
  });

  it('follows the white-label product name', async () => {
    expect((await t.api(owner).patch('/platform/settings', { product_name: 'Acme Work' })).status).toBe(200);
    try {
      const quick = (await (await t.api(admin, accountId).get('/extensions/docs/quickstart')).json()) as Json;
      expect(quick.product_name).toBe('Acme Work');
      expect(quick.html).toContain('build your first Acme Work extension');
    } finally {
      await t.api(owner).patch('/platform/settings', { product_name: null });
    }
  });

  it('is for admins only, needs a session, and knows only its two pages', async () => {
    expect((await t.api(member, accountId).get('/extensions/docs/guide')).status).toBe(403);
    expect((await t.app.request('/api/v1/extensions/docs/guide')).status).toBe(401);
    expect((await t.api(admin, accountId).get('/extensions/docs/nope')).status).toBe(400);
  });
});
