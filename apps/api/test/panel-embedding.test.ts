// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { embeddingOriginSchema, platformSettingsSchema } from '@bines/shared';
import { isPanelPath, securityHeaders } from '../src/middleware/security-headers';
import type { AppEnv } from '../src/types';

/**
 * an extension's panel page (`/a/<account>/x/<installation>/panel`) is the only page of the app
 * another site may frame — and only the sites the platform owner listed ("allowed embedding origins"), e.g. a browser
 * extension's side panel. Every other page and the API stay `frame-ancestors 'none'` + `X-Frame-Options: DENY`.
 */
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const directive = (csp: string, name: string) =>
  csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `)) ?? '';

const appWith = (origins: string[]) => {
  const app = new Hono<AppEnv>();
  app.use(
    '*',
    securityHeaders(
      { S3_ENDPOINT: undefined, NODE_ENV: 'production' },
      undefined,
      undefined,
      undefined,
      undefined,
      () => Promise.resolve(origins),
    ),
  );
  app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.json({}) : c.html('<!doctype html>')));
  return app;
};

describe('panel embedding', () => {
  it('knows the panel path and nothing else', () => {
    expect(isPanelPath('/a/acme/x/01HFAKE0000000000000000000/panel')).toBe(true);
    expect(isPanelPath('/a/acme/x/01HFAKE0000000000000000000/panel/')).toBe(true);
    expect(isPanelPath('/a/acme/b/01HFAKE0000000000000000000')).toBe(false);
    expect(isPanelPath('/a/acme/x/1/panel/more')).toBe(false);
    expect(isPanelPath('/api/v1/a/acme/x/1/panel')).toBe(false);
  });

  it('lets the allowed origins frame the panel page only', async () => {
    const app = appWith([EXT, 'https://crm.example.com']);
    const panel = await app.request('/a/acme/x/01HFAKE0000000000000000000/panel');
    expect(panel.headers.get('X-Frame-Options')).toBeNull();
    expect(directive(panel.headers.get('Content-Security-Policy') ?? '', 'frame-ancestors')).toBe(
      `frame-ancestors ${EXT} https://crm.example.com`,
    );
    const board = await app.request('/a/acme/b/01HFAKE0000000000000000000');
    expect(board.headers.get('X-Frame-Options')).toBe('DENY');
    expect(directive(board.headers.get('Content-Security-Policy') ?? '', 'frame-ancestors')).toBe(
      "frame-ancestors 'none'",
    );
    const api = await app.request('/api/v1/a/acme/x/1/panel');
    expect(api.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('without allowed origins the panel page is not framed either', async () => {
    const panel = await appWith([]).request('/a/acme/x/01HFAKE0000000000000000000/panel');
    expect(panel.headers.get('X-Frame-Options')).toBe('DENY');
    expect(directive(panel.headers.get('Content-Security-Policy') ?? '', 'frame-ancestors')).toBe(
      "frame-ancestors 'none'",
    );
  });

  it('accepts browser-extension and https origins only', () => {
    expect(embeddingOriginSchema.safeParse(EXT).success).toBe(true);
    expect(embeddingOriginSchema.safeParse('https://crm.example.com').success).toBe(true);
    for (const bad of ['*', 'http://crm.example.com', 'https://x.com/path', 'chrome-extension://short', "'self'"])
      expect(embeddingOriginSchema.safeParse(bad).success, bad).toBe(false);
    expect(platformSettingsSchema.parse({}).embedding.allowed_origins).toEqual([]);
  });
});
