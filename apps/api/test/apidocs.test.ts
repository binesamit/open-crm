// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { loadEnv } from '../src/env';
import { fullOpenApiDocument, MAX_REQUEST_BYTES } from '../src/app';
import { guideContext } from '../src/modules/apidocs/apidocs.routes';
import { DESCRIPTIONS } from '../src/modules/apidocs/descriptions';
import { DEFAULT_N8N_PACKAGE, defaultPlatformSettings, platformSettingsSchema } from '@bines/shared';
import { buildPublicSpec, operationsOf, opKey, type OpenApiDoc } from '../src/modules/apidocs/spec';
import { F4 } from '../src/modules/apidocs/theme';

let t: TestContext;
let full: OpenApiDoc;
let pub: OpenApiDoc;

beforeAll(async () => {
  t = await createTestContext();
  full = fullOpenApiDocument(t.app);
  const res = await t.app.request('/api/docs/openapi.json');
  expect(res.status).toBe(200);
  pub = (await res.json()) as OpenApiDoc;
});
afterAll(() => t.close());

const hasExample = (media: { example?: unknown; examples?: unknown } | undefined) =>
  !!media && (media.example !== undefined || media.examples !== undefined);

describe('public API reference — the document', () => {
  it('builds from the routes and keeps every public operation documented', () => {
    const ops = operationsOf(pub);
    expect(ops.length).toBeGreaterThan(250);
    const missing: string[] = [];
    for (const { method, path, op } of ops) {
      const key = opKey(method, path);
      const own = full.paths[path]?.[method]?.description?.trim();
      const words = DESCRIPTIONS[key];
      if (!op.summary?.trim()) missing.push(`${key}: summary`);
      if (!own && !words?.[1]?.trim()) missing.push(`${key}: description (add it to apidocs/descriptions.ts)`);
      // Request: every JSON body has an example.
      const body = op.requestBody?.content?.['application/json'];
      if (body && !hasExample(body)) missing.push(`${key}: request example`);
      // Response: every success answer with a body has an example in at least one of its media types.
      for (const [status, res] of Object.entries(op.responses ?? {})) {
        if (!/^2/.test(status) || !res.content || !Object.keys(res.content).length) continue;
        if (!Object.values(res.content).some(hasExample)) missing.push(`${key}: ${status} response example`);
      }
      if (!op['x-required-scope'] && op['x-required-scope'] !== null) missing.push(`${key}: scope`);
    }
    expect(missing).toEqual([]);
  });

  it('has no stale wording for operations that are gone or not public', () => {
    const live = new Set(operationsOf(pub).map(({ method, path }) => opKey(method, path)));
    expect(Object.keys(DESCRIPTIONS).filter((k) => !live.has(k))).toEqual([]);
  });

  it('leaves out internal and owner-only operations', () => {
    const paths = Object.keys(pub.paths);
    for (const prefix of [
      '/platform/',
      '/auth/tokens',
      '/auth/service-tokens',
      '/extensions',
      '/ext/',
      '/mcp-servers',
    ]) {
      expect(
        paths.filter((p) => p.startsWith(prefix)),
        prefix,
      ).toEqual([]);
    }
    expect(paths.filter((p) => p.startsWith('/ai/assistant'))).toEqual([]);
    expect(paths.filter((p) => p.startsWith('/oauth-requests'))).toEqual([]);
    // …and their schemas do not leak through "Models".
    const json = JSON.stringify(pub);
    expect(json).not.toContain('/platform/accounts');
  });

  it('puts every resource in the navigation and names every scope', () => {
    const groups = pub['x-tagGroups'] as { name: string; tags: string[] }[];
    expect(groups.find((g) => g.name === 'More')).toBeUndefined();
    const grouped = new Set(groups.flatMap((g) => g.tags));
    for (const { op } of operationsOf(pub)) for (const tag of op.tags ?? []) expect(grouped.has(tag), tag).toBe(true);
    expect(pub.paths['/items/{id}']!.get!.description).toContain('`boards:read`');
    expect(pub.paths['/health']!.get!.security).toEqual([]);
  });

  it('documents the board activity filters', () => {
    const op = pub.paths['/boards/{id}/activity']!.get! as {
      description?: string;
      parameters?: { name: string; in: string }[];
    };
    const names = (op.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['before', 'actor_id', 'column', 'type', 'from', 'to', 'q']));
    for (const word of ['`actor_id`', '`column`', '`type`', '`from`', '`q`', '`system`'])
      expect(op.description, word).toContain(word);
  });

  it('documents who viewed a board (r18boardviews); reporting an open stays the app’s', () => {
    const op = pub.paths['/boards/{id}/viewers']!.get! as {
      description?: string;
      parameters?: { name: string; in: string }[];
      'x-required-scope'?: string;
    };
    const names = (op.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['limit', 'cursor']));
    expect(op['x-required-scope']).toBe('boards:read');
    for (const word of ['`last_viewed_at`', '`next_cursor`', '`enabled`', 'guest'])
      expect(op.description).toContain(word);
    expect(pub.paths['/boards/{id}/viewers']!.post).toBeUndefined();
  });

  it('does not cite internal design docs', () => {
    const texts: string[] = [];
    const walk = (v: unknown) => {
      if (!v || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'description' || k === 'summary') && typeof x === 'string') texts.push(x);
        else walk(x);
      }
    };
    walk(pub.paths);
    walk(pub.components);
    expect(texts.filter((s) => /§|\(D\d{1,2}\)|\b\d{2}-[A-Z]{4,}/.test(s))).toEqual([]);
  });

  it('carries the guide pages', () => {
    const md = String(pub.info.description);
    for (const page of [
      '# Getting started',
      '# Authentication',
      '# Errors',
      '# Pagination',
      '# Rate limits & quotas',
      '# Idempotency',
      '# Webhooks',
      '# n8n and Make',
      '# MCP',
      '# Extensions',
    ])
      expect(md, page).toContain(page);
    // Numbers come from the code: the error table lists every error code.
    expect(md).toContain('`idempotency_conflict`');
    expect(md).toContain('`rate_limited`');
  });

  it('is white-label: product name, logo and API budgets come from Platform settings, the env is the fallback', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      WEB_ORIGIN: 'https://work.acme.example',
      PRODUCT_NAME: 'Env Name',
      API_DOCS_LOGO_URL: 'https://cdn.env.example/logo.svg',
    });
    const settings = platformSettingsSchema.parse({
      product_name: 'Acme Work',
      api_docs: { logo_url: 'https://cdn.acme.example/logo.svg' },
      api_limits: { token_per_minute: 321, personal_daily: 4_321 },
    });
    const md = String(buildPublicSpec(full, guideContext(env, MAX_REQUEST_BYTES, settings)).info.description);
    expect(md).toContain('https://cdn.acme.example/logo.svg');
    expect(md).not.toContain('cdn.env.example');
    expect(md).not.toContain('Env Name');
    // The guide shows the platform's defaults and says an account / a token may override them.
    expect(md).toContain('| Per token, per minute | 321 (service tokens 1,200)');
    expect(md).toContain('| Per token, per day | 4,321 (service tokens 50,000)');
    expect(md).toContain('Administration → API');
    // Built-in defaults when nothing is set.
    const plain = String(
      buildPublicSpec(full, guideContext(env, MAX_REQUEST_BYTES, defaultPlatformSettings())).info.description,
    );
    expect(plain).toContain('| Per token, per minute | 600 (service tokens 1,200)');
  });

  it('documents n8n and Make with the configured package, invitation link and product name', () => {
    const env = loadEnv({ NODE_ENV: 'test', WEB_ORIGIN: 'https://work.acme.example' });
    const link = 'https://www.make.com/en/hq/app-invitation/0123456789abcdef';
    const settings = platformSettingsSchema.parse({
      product_name: 'Acme Work',
      integrations: { n8n_package: '@acme/n8n-nodes-work', make_invitation_url: link },
    });
    const md = String(buildPublicSpec(full, guideContext(env, MAX_REQUEST_BYTES, settings)).info.description);
    expect(md).toContain('# n8n and Make');
    expect(md).toContain('Settings → Community nodes → Install');
    expect(md).toContain('`@acme/n8n-nodes-work`');
    expect(md).toContain(`(${link})`);
    expect(md).toContain('Add the Acme Work node');
    expect(md).toContain('`https://work.acme.example`');
    expect(md).not.toContain('ask your administrator');
    // Nothing set: the built-in package and no link — "ask your administrator".
    const plain = String(
      buildPublicSpec(full, guideContext(env, MAX_REQUEST_BYTES, defaultPlatformSettings())).info.description,
    );
    expect(plain).toContain(`\`${DEFAULT_N8N_PACKAGE}\``);
    expect(plain).toContain('ask your administrator');
    expect(plain).not.toContain('app-invitation');
  });

  it("follows the owner's Platform settings live (name, logo, colour)", async () => {
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    const res = await t.api(owner).patch('/platform/settings', {
      product_name: 'Acme Work',
      api_docs: { logo_url: 'https://cdn.acme.example/logo.svg', brand_color: '#123456' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { settings: { api_docs: unknown } }).settings.api_docs).toEqual({
      logo_url: 'https://cdn.acme.example/logo.svg',
      brand_color: '#123456',
    });
    expect((await t.api(owner).patch('/platform/settings', { api_docs: { brand_color: 'red' } })).status).toBe(400);
    try {
      const doc = (await (await t.app.request('/api/docs/openapi.json')).json()) as OpenApiDoc;
      expect(doc.info.title).toBe('Acme Work API');
      const html = await (await t.app.request('/api/docs')).text();
      expect(html).toContain('<title>Acme Work API reference</title>');
      expect(html).toContain('<link rel="icon" href="https://cdn.acme.example/logo.svg" />');
      expect(await (await t.app.request('/api/docs/theme.css')).text()).toContain('#123456');
    } finally {
      await t.api(owner).patch('/platform/settings', {
        product_name: null,
        api_docs: { logo_url: null, brand_color: null },
      });
    }
    const back = (await (await t.app.request('/api/docs/openapi.json')).json()) as OpenApiDoc;
    expect(back.info.title).not.toBe('Acme Work API');
  });

  it('is white-label from the env when Platform settings are empty: product name, base URL and logo', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      WEB_ORIGIN: 'https://work.acme.example',
      PRODUCT_NAME: 'Acme Work',
      API_DOCS_LOGO_URL: 'https://cdn.acme.example/logo.svg',
    });
    const doc = buildPublicSpec(full, guideContext(env, MAX_REQUEST_BYTES));
    expect(doc.info.title).toBe('Acme Work API');
    expect(doc.servers).toEqual([{ url: 'https://work.acme.example/api/v1', description: 'Acme Work' }]);
    expect(String(doc.info.description)).toContain('https://cdn.acme.example/logo.svg');
    expect(String(doc.info.description)).toContain('https://work.acme.example/mcp');
    expect(String(doc.info.description)).not.toContain('Bines OS');
  });
});

describe('public API reference — the page', () => {
  it('serves the page under a strict CSP with no CDN and no inline script', async () => {
    const res = await t.app.request('/api/docs');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).not.toContain('cdn.');
    const html = await res.text();
    expect(html).toContain('/api/docs/scalar.js');
    expect(html).toContain('/api/docs/theme.css');
    // Every <script> either has a same-origin src or is JSON data (not executed).
    for (const tag of html.match(/<script[^>]*>/g) ?? []) {
      expect(tag, tag).toMatch(/src="\/api\/docs\/|type="application\/json"/);
    }
    expect(html).not.toMatch(/https?:\/\/(cdn|unpkg|fonts)\./);
  });

  it('serves the renderer bundle and its start-up script from this origin', async () => {
    const js = await t.app.request('/api/docs/scalar.js', { headers: { 'accept-encoding': 'gzip' } });
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('content-encoding')).toBe('gzip');
    const etag = js.headers.get('etag')!;
    const again = await t.app.request('/api/docs/scalar.js', { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    const init = await (await t.app.request('/api/docs/init.js')).text();
    expect(init).toContain('createApiReference');
    const css = await t.app.request('/api/docs/theme.css');
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('uses the product tokens (F4) exactly', () => {
    const tokens = readFileSync(new URL('../../../packages/ui/src/tokens.css', import.meta.url), 'utf8');
    const light = tokens.slice(tokens.indexOf(':root {'), tokens.indexOf("[data-theme='dark']"));
    const dark = tokens.slice(tokens.indexOf("[data-theme='dark']"), tokens.indexOf('@media'));
    const value = (block: string, name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
    const kebab = (k: string) => k.replace(/[A-Z0-9]/g, (c) => `-${c.toLowerCase()}`);
    for (const [k, v] of Object.entries(F4.light)) expect(value(light, kebab(k)), k).toBe(v);
    for (const [k, v] of Object.entries(F4.dark)) expect(value(dark, kebab(k)), k).toBe(v);
  });
});
