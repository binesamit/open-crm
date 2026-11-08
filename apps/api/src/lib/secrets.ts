// SPDX-License-Identifier: AGPL-3.0-only
import { hkdfSync } from 'node:crypto';
import { gcmOpen, gcmSeal, parseKey32 } from '@bines/server-crypto';
import type { Env } from '../env';

/**
 * Secrets at rest (AI connection keys, D26; later outbound MCP servers): AES-256-GCM with a random 12-byte IV,
 * stored as `v1.<iv>.<tag>.<ciphertext>` (base64url). The key is `SECRETS_KEY` (32 bytes, base64 or hex) or, when
 * unset, derived with HKDF from `BETTER_AUTH_SECRET` (required in production) — so no new variable is needed to
 * start, and setting SECRETS_KEY later only needs the saved keys to be entered again. Never logged (CLAUDE.md 10).
 */
const DEV_FALLBACK = 'bines-dev-only-secret-not-for-production';

// The AES-256-GCM primitives live in @bines/server-crypto (the worker uses them too); re-exported for the API.
export { gcmOpen, gcmSeal, parseKey32 };

export type SecretBox = { seal: (plain: string) => string; open: (sealed: string) => string };

const keyFrom = (env: Pick<Env, 'SECRETS_KEY' | 'BETTER_AUTH_SECRET'>): Buffer => {
  if (env.SECRETS_KEY) {
    const raw = parseKey32(env.SECRETS_KEY);
    if (!raw) throw new Error('SECRETS_KEY must be 32 bytes (base64 or 64 hex characters)');
    return raw;
  }
  const base = env.BETTER_AUTH_SECRET ?? DEV_FALLBACK;
  return Buffer.from(hkdfSync('sha256', base, 'bines-os', 'secrets-v1', 32));
};

export const createSecretBox = (env: Pick<Env, 'SECRETS_KEY' | 'BETTER_AUTH_SECRET'>): SecretBox => {
  const key = keyFrom(env);
  return {
    seal: (plain) => gcmSeal(key, plain),
    open: (sealed) => gcmOpen(key, sealed).toString('utf8'),
  };
};

/** `…AbCd`: the last 4 characters of a key, to recognise it in the list. */
export const keyHint = (key: string) => `…${key.slice(-4)}`;
