// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, EE_FEATURE_KEYS, type LicenseState, type LicenseStatus, licenseTiming } from '@bines/shared';
import type { Db } from '../../db/client';
import type { SessionUser } from '../../types';
import { getInstanceId } from './instance';
import { trustStoredLicenseKeys, verifyLicenseKey } from './license-key';
import { countActiveUsers, readSettingsRow, writeSettingsRow } from './license.repo';

/**
 * The installation's license (docs/LICENSING.md): one `platform_settings` row (id `license`) holding the key the
 * platform owner pasted or uploaded (or the registration installed). It is verified on every read (cheap, offline),
 * so an expiry takes effect by itself; read on the gate path, so cached briefly.
 *
 * In force = valid, expiring or within the grace period. After the grace period — or once an online check learned it
 * was revoked — ONLY the key's licensed features turn off: nothing becomes read-only and no data is touched.
 */
const ROW_ID = 'license';
const CACHE_MS = 30_000;
type Stored = { key: string; installed_at: string; checked_at?: string | null; revoked?: boolean };
let cache: { at: number; value: Stored | null } | null = null;

/**
 * Before a verification: the keys this installation trusts beside the built-in one — its provider's (the license
 * server it registers with) and its own console-made signing key — read from this database, never from the process.
 */
const refreshTrust = async (db: Db) => {
  const [licensing, server] = await Promise.all([
    readSettingsRow(db, 'licensing') as Promise<{ server_public_key?: string | null } | null>,
    readSettingsRow(db, 'license_server') as Promise<{ public_key_pem?: string | null } | null>,
  ]);
  trustStoredLicenseKeys({ provider: licensing?.server_public_key ?? null, own: server?.public_key_pem ?? null });
};

const loadStored = async (db: Db): Promise<Stored | null> => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const [s] = await Promise.all([readSettingsRow(db, ROW_ID) as Promise<Partial<Stored> | null>, refreshTrust(db)]);
  const value =
    typeof s?.key === 'string' && s.key
      ? { key: s.key, installed_at: s.installed_at ?? '', checked_at: s.checked_at ?? null, revoked: !!s.revoked }
      : null;
  cache = { at: Date.now(), value };
  return value;
};

/** Tests and owner writes: read the row again. */
export const forgetLicense = () => {
  cache = null;
};

/** The installed key (raw) and what an online check recorded — for the licensing service. */
export const storedLicense = loadStored;

/** The features the installed key unlocks now (empty without a key in force). */
export const licensedFeatures = async (db: Db, now = new Date()): Promise<string[]> => {
  const stored = await loadStored(db);
  if (!stored || stored.revoked) return [];
  const check = verifyLicenseKey(stored.key, undefined, now, await getInstanceId(db));
  return check.ok ? check.payload.features : [];
};

/**
 * Edition limits: does the installed key prove this installation registered? Any key signed by the
 * licensor for this installation does — in force, or expired (after the grace only its licensed features stop; the
 * installation stays registered). A revoked key, another installation's, or none: no. Returns the key's plan
 * (`null` plan = a key made before editions), or `false`.
 */
export const registrationKeyPlan = async (db: Db, now = new Date()): Promise<string | null | false> => {
  const stored = await loadStored(db);
  if (!stored || stored.revoked) return false;
  const check = verifyLicenseKey(stored.key, undefined, now, await getInstanceId(db));
  if (check.ok) return check.payload.plan ?? null;
  return check.problem === 'expired' && check.payload ? (check.payload.plan ?? null) : false;
};

/** Is a licensed feature on for the whole installation now (the installation-level gate, e.g. `update_check`)? */
export const installationHasFeature = async (db: Db, key: string, now = new Date()) =>
  (await licensedFeatures(db, now)).includes(key);

export const licenseStatus = async (db: Db, now = new Date()): Promise<LicenseStatus> => {
  const [stored, instance_id, seats_used] = await Promise.all([
    loadStored(db),
    getInstanceId(db),
    countActiveUsers(db),
  ]);
  const base = {
    ee_features: [...EE_FEATURE_KEYS],
    installed_at: stored?.installed_at || null,
    instance_id,
    seats_used,
    checked_at: stored?.checked_at ?? null,
  };
  if (!stored)
    return {
      ...base,
      state: 'none',
      problem: null,
      licensee: null,
      features: [],
      expires: null,
      id: null,
      issued_at: null,
      plan: null,
      support: null,
      seats: null,
      seats_exceeded: false,
      grace_days: null,
      grace_ends: null,
      days_left: null,
      key_instance_id: null,
    };
  const check = verifyLicenseKey(stored.key, undefined, now, instance_id);
  const p = check.payload;
  const timing = p ? licenseTiming(p, now) : null;
  const state: LicenseState = stored.revoked
    ? 'revoked'
    : check.ok
      ? check.phase
      : check.problem === 'expired'
        ? 'expired'
        : 'invalid';
  const seats = p?.seats ?? null;
  return {
    ...base,
    state,
    problem: stored.revoked ? 'revoked' : check.ok ? null : check.problem,
    licensee: p?.licensee ?? null,
    features: p?.features ?? [],
    expires: p?.expires ?? null,
    id: p?.id ?? null,
    issued_at: p?.issued_at ?? null,
    plan: p?.plan ?? null,
    support: p?.support ?? null,
    seats,
    // A warning only: work is never blocked by the seat count.
    seats_exceeded: seats !== null && seats_used > seats,
    grace_days: p ? (p.grace_days ?? null) : null,
    grace_ends: timing?.grace_ends ?? null,
    days_left: timing?.days_left ?? null,
    key_instance_id: p?.instance_id ?? null,
  };
};

const save = async (db: Db, ownerId: string | null, settings: Stored | Record<string, never>) => {
  await writeSettingsRow(db, ROW_ID, settings, ownerId);
  // Feature gates read the license through this cache: a change applies at once.
  forgetLicense();
};

/**
 * PUT /platform/license: only a key in force here is installed (400 `license_invalid` {problem}: unreadable, not
 * signed by the licensor, for another installation, or past its grace period). `ownerId` null = the registration
 * flow installing its Registered key.
 */
export const installLicenseKey = async (db: Db, ownerId: string | null, key: string) => {
  await refreshTrust(db);
  const check = verifyLicenseKey(key, undefined, new Date(), await getInstanceId(db));
  if (!check.ok) throw new AppError('license_invalid', `License key: ${check.problem}`, { problem: check.problem });
  await save(db, ownerId, { key: key.trim(), installed_at: new Date().toISOString(), checked_at: null });
  return licenseStatus(db);
};

export const installLicense = (db: Db, owner: SessionUser, key: string) => installLicenseKey(db, owner.id, key);

/** An online check's verdict (licensing.service): when it ran, and whether the licensor revoked the key. */
export const recordLicenseCheck = async (db: Db, ownerId: string | null, revoked: boolean) => {
  const stored = await loadStored(db);
  if (!stored) return;
  await save(db, ownerId, { ...stored, checked_at: new Date().toISOString(), revoked });
};

/** DELETE /platform/license: back to no license. */
export const removeLicense = async (db: Db, owner: SessionUser) => {
  await save(db, owner.id, {});
  return licenseStatus(db);
};
