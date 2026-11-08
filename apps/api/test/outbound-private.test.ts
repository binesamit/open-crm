// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { allowPrivateOutbound, assertPublicUrl } from '../src/lib/outbound';

/** Audit 2026-10-10 #7: private / loopback outbound addresses only by an explicit development switch (or tests). */
describe('outbound to private addresses', () => {
  it('is never implied by a missing or non-production NODE_ENV', () => {
    expect(allowPrivateOutbound({ NODE_ENV: 'development' })).toBe(false);
    expect(allowPrivateOutbound({})).toBe(false);
    expect(allowPrivateOutbound({ NODE_ENV: 'production' })).toBe(false);
    expect(allowPrivateOutbound({ NODE_ENV: 'development', OUTBOUND_ALLOW_PRIVATE: '1' })).toBe(true);
    expect(allowPrivateOutbound({ NODE_ENV: 'production', OUTBOUND_ALLOW_PRIVATE: '1' })).toBe(false);
    expect(allowPrivateOutbound({ NODE_ENV: 'test' })).toBe(true);
  });

  it('a development server without the switch refuses loopback and metadata hosts', async () => {
    const allow = allowPrivateOutbound({ NODE_ENV: 'development' });
    await expect(assertPublicUrl('http://127.0.0.1:5432/', allow)).rejects.toThrow('webhook_url_private');
    await expect(assertPublicUrl('http://169.254.169.254/latest', allow)).rejects.toThrow('webhook_url_private');
  });

  it('production refuses to start with the switch on', () => {
    expect(() => loadEnv({ NODE_ENV: 'development', OUTBOUND_ALLOW_PRIVATE: '1' })).not.toThrow();
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        DATA_DIR: '/data',
        BETTER_AUTH_SECRET: 'q7Zt3LxP9mWv2KcR8nYb4HsJ6dFg1TeA5uQo0iVp',
        OUTBOUND_ALLOW_PRIVATE: '1',
      }),
    ).toThrow(/OUTBOUND_ALLOW_PRIVATE/);
  });

  it('production takes another mail receiving API only over https, never a local stand-in', () => {
    const prod = (RESEND_API_BASE: string) =>
      loadEnv({
        NODE_ENV: 'production',
        DATA_DIR: '/data',
        BETTER_AUTH_SECRET: 'q7Zt3LxP9mWv2KcR8nYb4HsJ6dFg1TeA5uQo0iVp',
        RESEND_API_BASE,
      });
    for (const bad of ['http://127.0.0.1:3998', 'https://localhost:3998', 'https://127.0.0.1', 'ftp://mail.example'])
      expect(() => prod(bad), bad).toThrow(/RESEND_API_BASE/);
    expect(() => prod('https://api.mail-provider.example')).not.toThrow();
    expect(() => loadEnv({ NODE_ENV: 'development', RESEND_API_BASE: 'http://127.0.0.1:3998' })).not.toThrow();
  });
});
