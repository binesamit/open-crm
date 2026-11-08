// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createCrypto, keyFrom, secretHint } from '../src/crypto';

const c = createCrypto('a-test-key-that-is-long-enough');

describe('secrets at rest (AES-256-GCM)', () => {
  it('round-trips, with a fresh IV each time', () => {
    const a = c.encrypt('refresh-token-1');
    const b = c.encrypt('refresh-token-1');
    expect(a).not.toBe(b);
    expect(a).not.toContain('refresh');
    expect(c.decrypt(a)).toBe('refresh-token-1');
    expect(c.decrypt(c.encrypt(''))).toBe('');
    expect(c.decrypt(c.encrypt('שלום 🔐'))).toBe('שלום 🔐');
  });

  it('a changed ciphertext or another key is refused', () => {
    const box = c.encrypt('secret');
    const [v, iv, tag, ct] = box.split('.') as [string, string, string, string];
    const bytes = Buffer.from(ct, 'base64url');
    bytes[0] = bytes[0]! ^ 0xff;
    const flipped = [v, iv, tag, bytes.toString('base64url')].join('.');
    expect(() => c.decrypt(flipped)).toThrow();
    expect(() => createCrypto('another-key-that-is-long-enough').decrypt(box)).toThrow();
    expect(() => c.decrypt('garbage')).toThrow();
  });

  it('keys: 32 bytes as base64 or hex are taken as is', () => {
    const raw = Buffer.alloc(32, 7);
    expect(keyFrom(raw.toString('base64')).equals(raw)).toBe(true);
    expect(keyFrom(raw.toString('hex')).equals(raw)).toBe(true);
    expect(keyFrom('short words').length).toBe(32);
  });

  it('a hint shows only the end', () => {
    expect(secretHint('GOCSPX-abcdefgh1234')).toBe('••••1234');
  });
});

describe('signed state (OAuth) and channel tokens', () => {
  it('verifies its own, refuses changed, expired or other-purpose values', () => {
    const now = 1_000_000;
    const s = c.sign('oauth', { i: 'inst', u: 'user' }, 600_000, now);
    expect(c.verify('oauth', s, now + 1000)).toMatchObject({ i: 'inst', u: 'user', p: 'oauth' });
    expect(c.verify('oauth', s, now + 700_000)).toBeNull();
    expect(c.verify('channel', s, now)).toBeNull();
    const [body, mac] = s.split('.');
    const forged = Buffer.from(
      JSON.stringify({ i: 'other', u: 'user', p: 'oauth', x: now + 600_000, n: 'x' }),
    ).toString('base64url');
    expect(c.verify('oauth', `${forged}.${mac}`, now)).toBeNull();
    expect(c.verify('oauth', `${body}.AAAA`, now)).toBeNull();
    expect(createCrypto('another-key-that-is-long-enough').verify('oauth', s, now)).toBeNull();
    expect(c.verify('oauth', '', now)).toBeNull();
  });

  it('each state is unique (a nonce)', () => {
    expect(c.sign('oauth', {}, 1000)).not.toBe(c.sign('oauth', {}, 1000));
  });

  it('channel tokens are bound to the channel id', () => {
    expect(c.channelTokenOk('ch1', c.channelToken('ch1'))).toBe(true);
    expect(c.channelTokenOk('ch2', c.channelToken('ch1'))).toBe(false);
    expect(c.channelTokenOk('ch1', '')).toBe(false);
  });
});
