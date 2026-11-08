// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM primitives shared by the server processes (API and worker): one implementation of the sealed format
 * `v1.<iv>.<tag>.<ciphertext>` (base64url, random 12-byte IV, full 16-byte tag). Keys and values are never logged.
 */

/** A 32-byte key given as 64 hex characters or base64; null when it is not exactly 32 bytes. */
export const parseKey32 = (value: string): Buffer | null => {
  const raw = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  return raw.length === 32 ? raw : null;
};

/**
 * AES-256-GCM with a random 12-byte IV, as `v1.<iv>.<tag>.<ciphertext>` (base64url). `aad` binds the result to a
 * context (it must be given again to open it), so a sealed value cannot be moved to another place.
 */
export const gcmSeal = (key: Buffer, plain: Buffer | string, aad?: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([
    cipher.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain),
    cipher.final(),
  ]);
  return ['v1', iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
};

export const gcmOpen = (key: Buffer, sealed: string, aad?: string): Buffer => {
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('unknown secret format');
  // S-50: the full 16-byte tag only — GCM would otherwise accept a truncated one (down to 4 bytes).
  const authTag = Buffer.from(tag, 'base64url');
  if (authTag.length !== 16) throw new Error('unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
};
