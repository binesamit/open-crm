// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { securityHeaders, spaCsp } from '../src/middleware/security-headers';
import type { AppEnv } from '../src/types';

/**
 * Round 11 (reported: the Maps view showed no place / street names in production). The map's RTL text plugin is
 * WebAssembly; the SPA's CSP must allow compiling it (`'wasm-unsafe-eval'`) — and nothing wider (`'unsafe-eval'`).
 * NOTE: dev (Vite) sends no CSP, so the labels themselves can only be verified on staging / production.
 */
const directive = (csp: string, name: string) =>
  csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `)) ?? '';

describe('SPA CSP for the map (round 11)', () => {
  const env = { S3_ENDPOINT: undefined, NODE_ENV: 'production' as const };

  it("script-src allows WebAssembly ('wasm-unsafe-eval') but never 'unsafe-eval' or inline scripts", () => {
    const script = directive(spaCsp(env), 'script-src');
    expect(script.split(' ')).toEqual(['script-src', "'self'", "'wasm-unsafe-eval'"]);
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
  });

  it('keeps the plugin worker and the map tiles allowed', () => {
    const csp = spaCsp({ ...env, MAP_STYLE_URL: 'https://tiles.openfreemap.org/styles/liberty' });
    expect(directive(csp, 'worker-src')).toBe("worker-src 'self' blob:");
    expect(directive(csp, 'connect-src')).toContain('https://tiles.openfreemap.org');
  });

  it('is what a page answer carries in production; API answers stay locked down', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', securityHeaders(env));
    app.get('/a/x/b/1', (c) => c.html('<!doctype html>'));
    app.get('/api/v1/x', (c) => c.json({}));
    const page = (await app.request('/a/x/b/1')).headers.get('Content-Security-Policy') ?? '';
    expect(directive(page, 'script-src')).toContain("'wasm-unsafe-eval'");
    const api = (await app.request('/api/v1/x')).headers.get('Content-Security-Policy') ?? '';
    expect(api).not.toContain('wasm');
  });
});

/**
 * (product owner: "pressing record only pops an error, the browser never asks"): `microphone=` blocked the
 * microphone outright. Our own pages may ask for it (the browser then asks the person); nothing else is opened.
 */
describe('Permissions-Policy', () => {
  it('lets our own pages ask for the microphone; camera, location, payment and USB stay off', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', securityHeaders({ S3_ENDPOINT: undefined, NODE_ENV: 'production' as const }));
    app.get('/a/x/b/1', (c) => c.html('<!doctype html>'));
    const policy = (await app.request('/a/x/b/1')).headers.get('Permissions-Policy') ?? '';
    const rules = policy.split(',').map((r) => r.trim());
    expect(rules).toContain('microphone=(self)');
    for (const off of ['camera=()', 'geolocation=()', 'payment=()', 'usb=()']) expect(rules).toContain(off);
  });
});
