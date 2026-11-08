// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { AppError, LICENSE_KEY_PREFIX, type LicensePayload, type LicenseServerStatus } from '@bines/shared';
import type { Db } from '../../db/client';
import type { Env } from '../../env';
import type { Logger } from '../../lib/logger';
import type { SecretBox } from '../../lib/secrets';
import type { SessionUser } from '../../types';
import { insertPlatformAudit } from '../account-deletion/account-deletion.repo';
import { trustOwnLicenseKey } from './license-key';
import { readSettingsRow, writeSettingsRow } from './license.repo';

/**
 * The license server's signing key (docs/LICENSING.md, "The license server"). Any installation can be a license server for the
 * installations it serves: the platform owner makes an Ed25519 key pair in the owner console ("Create a signing key";
 * the private half is sealed with SECRET_MASTER_KEY in the `platform_settings` row `license_server`), or the operator
 * sets `LICENSE_SIGNING_KEY` in the environment (PKCS#8 PEM — real newlines or literal `\n` — base64 of that PEM, or
 * base64 of the DER). The console setting wins over the environment. The key is never logged or sent anywhere; an
 * unreadable value is reported once and treated as unset. Keys this server signs verify on this server too (its own
 * public key is trusted beside the built-in one and the provider's).
 */
export type LicenseSigner = { privateKey: KeyObject; publicKey: KeyObject; source: 'setting' | 'env' };

export const LICENSE_SERVER_ROW = 'license_server';
const CACHE_MS = 30_000;

type StoredServer = {
  signing_key_sealed?: string | null;
  /** The public half, in the clear: license.service reads it with the database alone to trust this server's keys. */
  public_key_pem?: string | null;
  created_at?: string | null;
  created_by?: string | null;
};
type Deps = { db: Db; env: Env; secrets: SecretBox; logger?: Logger };

const parseSigningKey = (raw: string): KeyObject => {
  let text = raw.trim().replace(/\\n/g, '\n');
  if (!text.includes('-----BEGIN')) {
    const der = Buffer.from(text.replace(/\s+/g, ''), 'base64');
    const decoded = der.toString('utf8');
    if (!decoded.includes('-----BEGIN')) return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    text = decoded;
  }
  return createPrivateKey(text);
};

const signerOf = (raw: string, source: LicenseSigner['source'], logger?: Logger): LicenseSigner | null => {
  try {
    const privateKey = parseSigningKey(raw);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
    return { privateKey, publicKey: createPublicKey(privateKey), source };
  } catch {
    logger?.warn(`license server: the ${source} signing key is not a readable Ed25519 private key — ignored`);
    return null;
  }
};

// Cached per environment object (one per process — or per test context), for a short while.
const caches = new WeakMap<object, { at: number; gen: number; value: LicenseSigner | null }>();
let generation = 0;
let warnedEnv = false;

/** Owner writes and tests: read the setting again. */
export const forgetLicenseSigner = () => {
  generation += 1;
};

/** The signer in force (null = this installation is not a license server): the console's key, else the env's. */
export const licenseSigner = async (deps: Deps): Promise<LicenseSigner | null> => {
  const cached = caches.get(deps.env);
  if (cached && cached.gen === generation && Date.now() - cached.at < CACHE_MS) return cached.value;
  let signer: LicenseSigner | null = null;
  const row = (await readSettingsRow(deps.db, LICENSE_SERVER_ROW)) as StoredServer | null;
  if (row?.signing_key_sealed) {
    try {
      signer = signerOf(deps.secrets.open(row.signing_key_sealed), 'setting', deps.logger);
    } catch {
      deps.logger?.warn(
        'license server: the stored signing key cannot be opened (SECRET_MASTER_KEY changed?) — ignored',
      );
    }
  }
  if (!signer && deps.env.LICENSE_SIGNING_KEY) {
    signer = signerOf(deps.env.LICENSE_SIGNING_KEY, 'env', warnedEnv ? undefined : deps.logger);
    warnedEnv = true;
  }
  // An env key is this process's: trusted process-wide. A console key is this database's: license.service reads its
  // public half from the row, so two installations sharing a process (tests) never trust each other by accident.
  trustOwnLicenseKey(signer?.source === 'env' ? signer.publicKey : null);
  caches.set(deps.env, { at: Date.now(), gen: generation, value: signer });
  return signer;
};

export const publicKeyPem = (k: KeyObject) => k.export({ type: 'spki', format: 'pem' }).toString().trim();

/** A short, stable name for a public key (shown beside the key so two sides can compare): sha256 of the DER. */
export const keyFingerprint = (k: KeyObject | string) => {
  const key = typeof k === 'string' ? createPublicKey(k) : k;
  const der = key.export({ type: 'spki', format: 'der' }) as Buffer;
  return createHash('sha256').update(der).digest('base64url').slice(0, 20);
};

/** GET /platform/license-server. */
export const licenseServerStatus = async (deps: Deps): Promise<LicenseServerStatus> => {
  const signer = await licenseSigner(deps);
  return {
    enabled: !!signer,
    source: signer?.source ?? 'none',
    public_key: signer ? publicKeyPem(signer.publicKey) : null,
    fingerprint: signer ? keyFingerprint(signer.publicKey) : null,
  };
};

/**
 * POST /platform/license-server/key (platform owner): make this installation a license server with a fresh Ed25519
 * pair. Refused while a key is already in force (409 `license_server_key_exists`): keys it signed would stop
 * verifying — remove the old one first, knowingly.
 */
export const createSigningKey = async (deps: Deps, owner: SessionUser): Promise<LicenseServerStatus> => {
  forgetLicenseSigner();
  const current = await licenseSigner(deps);
  if (current) throw new AppError('license_server_key_exists', 'This installation already has a signing key');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const row: StoredServer = {
    signing_key_sealed: deps.secrets.seal(pem),
    public_key_pem: publicKeyPem(publicKey),
    created_at: new Date().toISOString(),
    created_by: owner.id,
  };
  await writeSettingsRow(deps.db, LICENSE_SERVER_ROW, row as Record<string, unknown>, owner.id);
  await insertPlatformAudit(deps.db, {
    action: 'license_server.key_created',
    targetType: 'license_server',
    targetId: 'license_server',
    actorId: owner.id,
    payload: {},
  });
  forgetLicenseSigner();
  return licenseServerStatus(deps);
};

/**
 * DELETE /platform/license-server/key (platform owner): the console's key goes (an env key, if any, takes over).
 * Every key signed with it stops verifying on installations that trusted it — the console says so before.
 */
export const removeSigningKey = async (deps: Deps, owner: SessionUser): Promise<LicenseServerStatus> => {
  await writeSettingsRow(deps.db, LICENSE_SERVER_ROW, { signing_key_sealed: null, public_key_pem: null }, owner.id);
  await insertPlatformAudit(deps.db, {
    action: 'license_server.key_removed',
    targetType: 'license_server',
    targetId: 'license_server',
    actorId: owner.id,
    payload: {},
  });
  forgetLicenseSigner();
  return licenseServerStatus(deps);
};

/** `lic1.<payload>.<signature>` (the format in packages/shared/src/api/license.ts). */
export const signLicense = (privateKey: KeyObject, payload: LicensePayload) => {
  const signed = `${LICENSE_KEY_PREFIX}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${signed}.${sign(null, Buffer.from(signed), privateKey).toString('base64url')}`;
};
