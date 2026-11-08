// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fullOpenApiDocument } from '../src/app';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());

describe('GET /api/v1/health', () => {
  it('returns ok with a request id', async () => {
    const res = await t.app.request('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^req_/);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });
});

describe('error envelope', () => {
  it('unknown routes return the 404 envelope', async () => {
    const res = await t.app.request('/api/v1/nope', { headers: { 'x-request-id': 'abc12345' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'Route not found', request_id: 'abc12345' },
    });
  });

  it('validation errors use the envelope', async () => {
    const res = await t.app.request('/api/v1/invitations/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'short' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });
});

describe('OpenAPI', () => {
  it('the full document has every route', () => {
    const doc = fullOpenApiDocument(t.app);
    for (const path of ['/health', '/auth/me', '/me/accounts', '/platform/accounts', '/accounts/me', '/users/invite']) {
      expect(doc.paths[path], path).toBeDefined();
    }
  });

  it('S-47: /api/v1/openapi.json is the public document — no internal routes', async () => {
    const res = await t.app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    const pub = (await (await t.app.request('/api/docs/openapi.json')).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths).sort()).toEqual(Object.keys(pub.paths).sort());
    expect(doc.paths['/accounts/me']).toBeDefined();
    for (const internal of ['/platform/accounts', '/platform/settings', '/auth/config', '/me/password'])
      expect(doc.paths[internal], internal).toBeUndefined();
    expect(Object.keys(doc.paths).some((p) => p.startsWith('/platform'))).toBe(false);
  });

  it('S-47: the full document is for platform owners only (401 signed out, 404 to anyone else)', async () => {
    expect((await t.app.request('/api/v1/openapi.full.json')).status).toBe(401);
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    const res = await t.api(owner).get('/openapi.full.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths['/platform/accounts']).toBeDefined();
    // A signed-in account admin who is not the owner: 404 (the route does not advertise itself).
    await t.api(owner).post('/platform/accounts', {
      name: 'Acme',
      slug: 'acme-oa',
      first_admin_email: 'admin@acme-oa.test',
      template_set: 'empty',
    });
    const token = t.inviteTokenFor('admin@acme-oa.test');
    const admin = t.cookieFrom(await t.signUpWithPassword('admin@acme-oa.test', token))!;
    expect(admin).toBeTruthy();
    expect((await t.api(admin).get('/openapi.full.json')).status).toBe(404);
  });
});
