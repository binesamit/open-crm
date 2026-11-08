// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { KILL_SWITCH_SW } from '../src/web';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

let t: TestContext;
let app: TestContext['app'];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bines-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<html dir="rtl">spa</html>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'sw.js'), '/* real worker */');
  t = await createTestContext({ webDistDir: dir });
  app = t.app;
});
afterAll(() => t.close());

describe('web (SPA) serving', () => {
  it('serves the service worker always revalidated, or the kill switch when the owner turned it off (PWA)', async () => {
    const res = await app.request('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('service-worker-allowed')).toBe('/');
    expect(await res.text()).toBe('/* real worker */');
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    await t.api(owner).patch('/platform/settings', { pwa: { sw_enabled: false } });
    try {
      const killed = await (await app.request('/sw.js')).text();
      expect(killed).toBe(KILL_SWITCH_SW);
      expect(killed).toContain('unregister');
    } finally {
      await t.api(owner).patch('/platform/settings', { pwa: { sw_enabled: true } });
    }
  });

  it('serves hashed assets with long cache', async () => {
    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('falls back to index.html for client routes', async () => {
    const res = await app.request('/a/demo/b/123');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('spa');
  });

  it('the page carries a CSP (own scripts only, no framing) and the usual security headers', async () => {
    const res = await app.request('/a/demo/b/123');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('never serves the SPA for unknown API routes', async () => {
    const res = await app.request('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('still answers the API', async () => {
    expect((await app.request('/api/v1/health')).status).toBe(200);
  });
});

describe('env', () => {
  it('reads PORT from the platform', () => {
    expect(loadEnv({ PORT: '8080' }).API_PORT).toBe(8080);
    expect(loadEnv({ PORT: '8080', API_PORT: '3001' }).API_PORT).toBe(3001);
  });
});
