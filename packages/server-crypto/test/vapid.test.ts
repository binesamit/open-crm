// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { gcmOpen, gcmSeal, parseKey32, platformMasterKey, readVapidRow, vapidRowFor } from '../src';

const KEY = randomBytes(32);
const PAIR = { publicKey: 'BPub', privateKey: 'priv-d-value' };

describe('gcm', () => {
  it('seals and opens, bound to its context', () => {
    const sealed = gcmSeal(KEY, 'hello', 'ctx');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(gcmOpen(KEY, sealed, 'ctx').toString('utf8')).toBe('hello');
    expect(() => gcmOpen(KEY, sealed, 'other')).toThrow();
    expect(() => gcmOpen(randomBytes(32), sealed, 'ctx')).toThrow();
  });

  it('reads a 32-byte key as hex or base64 only', () => {
    expect(parseKey32(KEY.toString('hex'))).toEqual(KEY);
    expect(parseKey32(KEY.toString('base64'))).toEqual(KEY);
    expect(parseKey32('short')).toBeNull();
    expect(platformMasterKey(undefined)).toBeNull();
    expect(platformMasterKey('')).toBeNull();
    expect(platformMasterKey('not-a-key')).toBeNull();
  });
});

describe('the VAPID row at rest', () => {
  it('seals the private key with a master key; the public key stays readable', () => {
    const row = vapidRowFor(PAIR, KEY);
    expect(row.private_key).toBeUndefined();
    expect(row.public_key).toBe('BPub');
    expect(JSON.stringify(row)).not.toContain('priv-d-value');
    expect(readVapidRow(row, KEY)).toEqual({ state: 'ok', pair: PAIR, plain: false });
  });

  it('without a master key: stored and read in plain, as before', () => {
    const row = vapidRowFor(PAIR, null);
    expect(row).toEqual({ public_key: 'BPub', private_key: 'priv-d-value' });
    expect(readVapidRow(row, null)).toEqual({ state: 'ok', pair: PAIR, plain: true });
    // An old plain row is still read when a key appears (and flagged for sealing).
    expect(readVapidRow(row, KEY)).toEqual({ state: 'ok', pair: PAIR, plain: true });
  });

  it('a sealed row without (or with another) key is locked, never garbage', () => {
    const row = vapidRowFor(PAIR, KEY);
    expect(readVapidRow(row, null)).toEqual({ state: 'locked', publicKey: 'BPub' });
    expect(readVapidRow(row, randomBytes(32))).toEqual({ state: 'locked', publicKey: 'BPub' });
    // The sealed value is bound to this row: a copy into another secret's place does not open.
    expect(() => gcmOpen(KEY, row.private_key_enc!, 'secret-value:x')).toThrow();
  });

  it('no row, or a half row, is no pair', () => {
    expect(readVapidRow(null, KEY)).toEqual({ state: 'none' });
    expect(readVapidRow({}, KEY)).toEqual({ state: 'none' });
    expect(readVapidRow({ public_key: 'BPub' }, KEY)).toEqual({ state: 'none' });
  });
});
