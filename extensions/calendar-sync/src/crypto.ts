// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Secrets at rest (AES-256-GCM, key from CALSYNC_ENCRYPTION_KEY) and short-lived signed values (the OAuth state,
 * Google channel tokens) — HMAC-SHA256 with a key derived from the same secret.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const b64u = (b: Buffer) => b.toString('base64url');

/** 32 bytes from the configured key: base64 / hex of 32 bytes as is, any other string hashed. */
export const keyFrom = (raw: string): Buffer => {
  const s = raw.trim();
  if (!s) throw new Error('CALSYNC_ENCRYPTION_KEY is empty');
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, 'base64');
  if (b.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(s)) return b;
  return createHash('sha256').update(s).digest();
};

export type Crypto = ReturnType<typeof createCrypto>;

export const createCrypto = (rawKey: string) => {
  const key = keyFrom(rawKey);
  const macKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'calsync-mac', 32));

  const encrypt = (plain: string): string => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1.${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(ct)}`;
  };
  const decrypt = (box: string): string => {
    const [v, iv, tag, ct] = box.split('.');
    if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('bad_ciphertext');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  };

  const mac = (s: string) => b64u(createHmac('sha256', macKey).update(s).digest());
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  /** A signed, expiring value: `<payload b64url>.<mac>`. */
  const sign = (purpose: string, payload: Record<string, unknown>, ttlMs: number, now = Date.now()): string => {
    const body = b64u(Buffer.from(JSON.stringify({ ...payload, p: purpose, x: now + ttlMs, n: b64u(randomBytes(9)) })));
    return `${body}.${mac(body)}`;
  };
  /** The payload of a value `sign` made for `purpose`, or null (bad, expired, other purpose). */
  const verify = <T extends Record<string, unknown>>(purpose: string, value: string, now = Date.now()) => {
    const [body, sig] = String(value ?? '').split('.');
    if (!body || !sig || !same(mac(body), sig)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { p: string; x: number; n: string };
      if (p.p !== purpose || typeof p.x !== 'number' || p.x < now) return null;
      return p;
    } catch {
      return null;
    }
  };

  /** The token Google echoes on every push of a channel (proves the push is about a channel we opened). */
  const channelToken = (channelId: string) => mac(`channel:${channelId}`);
  const channelTokenOk = (channelId: string, token: string) => same(channelToken(channelId), token);

  return { encrypt, decrypt, sign, verify, channelToken, channelTokenOk };
};

/** What the settings page shows of a saved secret: its last 4 characters. */
export const secretHint = (secret: string) => (secret.length > 8 ? `••••${secret.slice(-4)}` : '••••');

export const randomId = () => randomBytes(16).toString('hex');
