// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { EXT_SIGNATURE_TOLERANCE_SECONDS, EXT_SIGNING_SECRET_PREFIX } from '@bines/shared';
import type { Db } from '../../db/client';
import { extensionInstallations } from '../../db/schema';
import type { Env } from '../../env';
import { signBody } from '../../lib/outbound';
import { createSecretBox, type SecretBox } from '../../lib/secrets';
import { findInstallationById, type InstallationRow } from './extensions.repo';

/**
 * Signed calls between the platform and an extension's server (D27 ת4, MARKETPLACE §8): each installation has its
 * own signing secret (random, sealed at rest — lib/secrets). Our automation calls carry
 * `X-Bines-Timestamp` (ms) + `X-Bines-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`; the extension's
 * trigger calls are signed the same way and checked here: a bad signature, a timestamp more than 5 minutes away
 * or the same signature twice (replay) is refused.
 *
 * ONE secret and ONE scheme per installation (`extension_installations.signing_secret`): the same key signs our
 * automation calls (ת4), checks its triggers (ת4) and signs the lifecycle webhooks of an extension with its own
 * server (ת6, server-side.ts) — the scheme is the platform's webhook signature (`lib/outbound` `signBody`). For an
 * extension with a server the secret is (re)issued with its credentials and delivered in the `installed` call;
 * otherwise an admin reads it in Administration → תוספות and gives it to the server.
 */
type SecretEnv = Pick<Env, 'SECRETS_KEY' | 'BETTER_AUTH_SECRET'>;

export const newSigningSecret = () => `${EXT_SIGNING_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;

/** The installation's secret — made (once, race-safe) on first need. */
export const signingSecretOf = async (deps: { db: Db; env: SecretEnv }, row: InstallationRow): Promise<string> => {
  const box = createSecretBox(deps.env);
  if (row.signingSecret) return box.open(row.signingSecret);
  await deps.db
    .update(extensionInstallations)
    .set({ signingSecret: box.seal(newSigningSecret()) })
    .where(and(eq(extensionInstallations.id, row.id), isNull(extensionInstallations.signingSecret)));
  const fresh = await findInstallationById(deps.db, row.id);
  return box.open(fresh!.signingSecret!);
};

/** The stored secret, without making one (lifecycle calls: none yet = nothing to sign with); null when unreadable. */
export const storedSigningSecret = (secrets: SecretBox, row: Pick<InstallationRow, 'signingSecret'>) => {
  if (!row.signingSecret) return null;
  try {
    return secrets.open(row.signingSecret);
  } catch {
    return null;
  }
};

/** A new secret (the old one stops at once — the extension's server must be given the new one). */
export const rotateSigningSecret = async (deps: { db: Db; env: SecretEnv }, row: InstallationRow) => {
  const secret = newSigningSecret();
  await deps.db
    .update(extensionInstallations)
    .set({ signingSecret: createSecretBox(deps.env).seal(secret) })
    .where(eq(extensionInstallations.id, row.id));
  return secret;
};

/** `sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>` — the one signing scheme (lib/outbound). */
export const signExtBody = signBody;

/** Signatures seen in the last tolerance window (per process): the same one again is a replay. */
const seen = new Map<string, number>();
const remember = (sig: string, now: number) => {
  if (seen.size > 50_000) for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
  if (seen.size > 50_000) seen.clear();
  seen.set(sig, now + EXT_SIGNATURE_TOLERANCE_SECONDS * 1000 * 2);
};

export type SignatureCheck = 'ok' | 'missing' | 'stale' | 'bad_signature' | 'replay';

/** Checks one signed call (timestamp window, HMAC in constant time, replay). Remembers it when it is good. */
export const verifyExtSignature = (
  secret: string,
  p: { timestamp: string | undefined; signature: string | undefined; body: string },
  now = Date.now(),
): SignatureCheck => {
  if (!p.timestamp || !p.signature) return 'missing';
  const ts = Number(p.timestamp);
  if (!/^\d{10,16}$/.test(p.timestamp) || !Number.isFinite(ts)) return 'stale';
  if (Math.abs(now - ts) > EXT_SIGNATURE_TOLERANCE_SECONDS * 1000) return 'stale';
  const want = Buffer.from(signExtBody(secret, p.timestamp, p.body));
  const got = Buffer.from(p.signature);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'bad_signature';
  const exp = seen.get(p.signature);
  if (exp && exp > now) return 'replay';
  remember(p.signature, now);
  return 'ok';
};
