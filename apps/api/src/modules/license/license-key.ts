// SPDX-License-Identifier: AGPL-3.0-only
import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import {
  LICENSE_KEY_PREFIX,
  type LicensePayload,
  licensePayloadSchema,
  type LicenseProblem,
  licenseTiming,
} from '@bines/shared';
import { LICENSE_PUBLIC_KEY_PEM } from './public-key';

/**
 * Offline license key verification (packages/shared/src/api/license.ts has the format): split
 * `lic1.<payload>.<signature>`, check the Ed25519 signature over `lic1.<payload>` with a trusted public key, parse
 * the payload, then check the installation (`instance_id`, when the key names one) and the time: a key is in force
 * until `expires` + `grace_days` (default 14). Pure — no database, no network.
 */
export type LicensePhase = 'valid' | 'expiring' | 'grace';
export type LicenseCheck =
  | { ok: true; payload: LicensePayload; phase: LicensePhase }
  | { ok: false; problem: LicenseProblem; payload?: LicensePayload };

let embedded: KeyObject | null = null;
let override: KeyObject | null = null;
/** The public half of this installation's own signing key (license-signing.ts): keys it issues verify here too. */
let own: KeyObject | null = null;
/** The provider's public key (the license server this installation registers with; licensing.service). */
let provider: KeyObject | null = null;
/** The console-made signing key's public half, read from this database (license.service). */
let settingOwn: KeyObject | null = null;
const embeddedKey = () => override ?? (embedded ??= createPublicKey(LICENSE_PUBLIC_KEY_PEM));
const trustedKeys = () => [
  embeddedKey(),
  ...(own ? [own] : []),
  ...(settingOwn ? [settingOwn] : []),
  ...(provider ? [provider] : []),
];

/** Tests only: trust another public key in place of the embedded one (null = back to it). */
export const trustLicensePublicKeyForTests = (pem: string | null) => {
  override = pem ? createPublicKey(pem) : null;
};

/** license-signing.ts: this server's own signing key is in force (null = none). */
export const trustOwnLicenseKey = (key: KeyObject | null) => {
  own = key;
};

const keyOrNull = (pem: string | null) => {
  try {
    return pem ? createPublicKey(pem) : null;
  } catch {
    return null;
  }
};

/**
 * license.service, before every verification: the provider's public key and this database's own console-made key
 * (PEM from the settings; null = none; an unreadable PEM = none).
 */
export const trustStoredLicenseKeys = (p: { provider: string | null; own: string | null }) => {
  provider = keyOrNull(p.provider);
  settingOwn = keyOrNull(p.own);
};

const B64URL = /^[A-Za-z0-9_-]+$/;

const signedBy = (signed: Buffer, sig: Buffer, keys: (KeyObject | string)[]) =>
  keys.some((k) => {
    try {
      return verify(null, signed, typeof k === 'string' ? createPublicKey(k) : k, sig);
    } catch {
      return false;
    }
  });

/**
 * `instanceId`: this installation's id — a key made for another one is refused (`instance_mismatch`). Keys made
 * before editions (no `instance_id`, no `grace_days`) keep working: any installation, 14 days' grace.
 */
export const verifyLicenseKey = (
  key: string,
  publicKey?: KeyObject | string,
  now: Date = new Date(),
  instanceId?: string | null,
): LicenseCheck => {
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_KEY_PREFIX || !B64URL.test(parts[1]!) || !B64URL.test(parts[2]!))
    return { ok: false, problem: 'malformed' };
  const [prefix, body, sig] = parts as [string, string, string];
  const keys = publicKey ? [publicKey] : trustedKeys();
  if (!signedBy(Buffer.from(`${prefix}.${body}`), Buffer.from(sig, 'base64url'), keys))
    return { ok: false, problem: 'bad_signature' };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, problem: 'bad_payload' };
  }
  const parsed = licensePayloadSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: 'bad_payload' };
  const payload = parsed.data;
  if (payload.instance_id && instanceId && payload.instance_id !== instanceId)
    return { ok: false, problem: 'instance_mismatch', payload };
  const { phase } = licenseTiming(payload, now);
  if (phase === 'expired') return { ok: false, problem: 'expired', payload };
  return { ok: true, payload, phase };
};
