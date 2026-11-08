// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest';
import { createServerClient, LifecycleSignatureError, signLifecycle, verifyLifecycle } from '../src/server';

/** @bines/ext-sdk/server: lifecycle signatures (same format as the platform's webhooks) and the token client. */
describe('verifyLifecycle', () => {
  const secret = 'bos_extw_test';
  const body = JSON.stringify({ event: 'updated', installation: { id: 'i1' } });

  it('accepts a fresh, correctly signed call and refuses a tampered or stale one', async () => {
    const ts = String(Date.now());
    const headers = { 'x-bines-timestamp': ts, 'x-bines-signature': await signLifecycle(secret, ts, body) };
    expect((await verifyLifecycle({ secret, headers, body })).event).toBe('updated');
    await expect(verifyLifecycle({ secret, headers, body: body.replace('i1', 'i2') })).rejects.toBeInstanceOf(
      LifecycleSignatureError,
    );
    await expect(verifyLifecycle({ secret: 'other', headers, body })).rejects.toThrow('bad signature');
    const old = String(Date.now() - 10 * 60_000);
    await expect(
      verifyLifecycle({
        secret,
        headers: { 'x-bines-timestamp': old, 'x-bines-signature': await signLifecycle(secret, old, body) },
        body,
      }),
    ).rejects.toThrow('stale timestamp');
  });

  it('`installed` can be read with the secret it carries (only when asked to, and only from our platform)', async () => {
    const forPlatform = (origin: string) =>
      JSON.stringify({
        event: 'installed',
        platform: origin,
        credentials: {
          signing_secret: 's2',
          client_id: 'bos_extc_1',
          client_secret: 'bos_exts_1',
          token_endpoint: `${origin}/oauth/token`,
          api_base: `${origin}/api/v1`,
        },
      });
    const signed = async (body: string) => {
      const ts = String(Date.now());
      return new Headers({ 'x-bines-timestamp': ts, 'x-bines-signature': await signLifecycle('s2', ts, body) });
    };
    const installed = forPlatform('https://app.bines.test');
    const headers = await signed(installed);
    await expect(verifyLifecycle({ headers, body: installed })).rejects.toThrow('no signing secret');
    // EXT-RT6: self-signed, so the platform must be pinned …
    await expect(verifyLifecycle({ headers, body: installed, trustInstalled: true })).rejects.toThrow(
      'platform origin required',
    );
    expect(
      (await verifyLifecycle({ headers, body: installed, trustInstalled: true, platform: 'https://app.bines.test' }))
        .event,
    ).toBe('installed');
    // … and a forged `installed` (its own secret, its own token endpoint) is refused.
    const forged = forPlatform('https://evil.test');
    await expect(
      verifyLifecycle({
        headers: await signed(forged),
        body: forged,
        trustInstalled: true,
        platform: 'https://app.bines.test',
      }),
    ).rejects.toThrow('another platform');
    const mixed = JSON.stringify({
      ...(JSON.parse(installed) as object),
      credentials: { ...(JSON.parse(installed) as { credentials: object }).credentials, api_base: 'https://evil.test' },
    });
    await expect(
      verifyLifecycle({
        headers: await signed(mixed),
        body: mixed,
        trustInstalled: true,
        platform: 'https://app.bines.test',
      }),
    ).rejects.toThrow('another platform');
  });

  it('createServerClient refuses a token endpoint on another origin than the API (EXT-RT6)', () => {
    expect(() =>
      createServerClient({
        client_id: 'bos_extc_1',
        client_secret: 'bos_exts_1',
        token_endpoint: 'https://evil.test/oauth/token',
        api_base: 'https://app.test/api/v1',
      }),
    ).toThrow('same origin');
  });
});

describe('createServerClient', () => {
  it('trades the credentials for a token once, and calls the API with it', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/oauth/token')) {
        expect(String((init?.headers as Record<string, string>).authorization)).toMatch(/^Basic /);
        expect(init?.body).toBe('grant_type=client_credentials');
        return new Response(JSON.stringify({ access_token: 'bos_xat_1', expires_in: 3600 }), { status: 200 });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer bos_xat_1');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const client = createServerClient(
      {
        client_id: 'bos_extc_1',
        client_secret: 'bos_exts_1',
        token_endpoint: 'https://app.test/oauth/token',
        api_base: 'https://app.test/api/v1',
      },
      { fetch: fetch as unknown as typeof globalThis.fetch },
    );
    expect(await client.api('GET', '/boards/b/items')).toEqual({ data: [] });
    await client.api('GET', '/boards/b/items');
    expect(fetch.mock.calls.filter((c) => String(c[0]).endsWith('/oauth/token')).length).toBe(1);
  });
});
