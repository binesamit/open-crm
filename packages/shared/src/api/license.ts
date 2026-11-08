// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import {
  DEFAULT_GRACE_DAYS,
  LICENSE_EXPIRING_DAYS,
  LICENSE_PLANS,
  LICENSED_FEATURE_KEYS,
  SUPPORT_LEVELS,
} from './editions';
import { featureKeySchema, planIncludesFeature } from './plans';

/**
 * License keys (docs/LICENSING.md; editions in editions.ts).
 *
 * A license key is a signed, offline file: `lic1.<payload>.<signature>` — the payload is base64url JSON
 * (`licensePayloadSchema`), the signature is Ed25519 over `lic1.<payload>`, made with the licensor's private key
 * (`pnpm license:sign`, or the license server's "Licenses" screen) and checked on the server against the public key
 * embedded in the code. No network call is needed. The platform owner pastes or uploads it in the owner console, or
 * the registration questionnaire installs a Registered key by itself.
 *
 * A key unlocks licensed features (`EE_FEATURE_KEYS`) for the whole installation; a plan can unlock them for one
 * account (`featureAllowed`). Keys made before editions (no plan / seats / instance / grace) stay valid.
 */

export const LICENSE_KEY_PREFIX = 'lic1';

export const licensePayloadSchema = z
  .object({
    /** Who the license is issued to (shown in the owner console). */
    licensee: z.string().trim().min(1).max(200),
    /** The licensed feature keys it unlocks (`EE_FEATURE_KEYS`; unknown keys are kept and simply unlock nothing). */
    features: z.array(featureKeySchema).max(100),
    /** When it stops being valid (ISO date-time); null = never. A grace period follows (`grace_days`). */
    expires: z.iso.datetime({ offset: true }).nullable(),
    /** The licensor's reference for this license (optional; a renewal keeps it). */
    id: z.string().max(64).optional(),
    /** When it was issued (ISO date-time, optional). */
    issued_at: z.iso.datetime({ offset: true }).optional(),
    /** The edition it is for (shown in the console). Absent on keys made before editions. */
    plan: z.enum(LICENSE_PLANS).optional(),
    /** Active users the installation may have — above it the console warns; nothing is blocked. null = no limit. */
    seats: z.number().int().min(1).max(10_000_000).nullable().optional(),
    /** The installation the key is for (`instance_id`); absent / null = any installation. */
    instance_id: z.string().trim().min(1).max(64).nullable().optional(),
    /** Days the key keeps working after `expires` (default `DEFAULT_GRACE_DAYS`). */
    grace_days: z.number().int().min(0).max(365).optional(),
    /** The support level (shown in the console; it unlocks no code). */
    support: z.enum(SUPPORT_LEVELS).optional(),
  })
  .meta({ id: 'LicensePayload' });
export type LicensePayload = z.infer<typeof licensePayloadSchema>;

/**
 * Why a key is not in force: unreadable, not signed by the licensor, a bad payload, past its grace period, made for
 * another installation, or revoked (known only after an online check).
 */
export const LICENSE_PROBLEMS = [
  'malformed',
  'bad_signature',
  'bad_payload',
  'expired',
  'instance_mismatch',
  'revoked',
] as const;
export type LicenseProblem = (typeof LICENSE_PROBLEMS)[number];

/**
 * The key's state on the license card:
 * - none: no key installed;
 * - valid: in force; expiring: in force, ends within `LICENSE_EXPIRING_DAYS`;
 * - grace: past `expires` but within `grace_days` — still in force, a red banner;
 * - expired: past the grace period — its licensed features are off (nothing else changes, no data is touched);
 * - revoked: an online check said the licensor revoked it — its features are off. Offline, revocation is unknown
 *   (`checked_at` null);
 * - invalid: unreadable, not signed by the licensor, or made for another installation.
 */
export const LICENSE_STATES = ['none', 'valid', 'expiring', 'grace', 'expired', 'revoked', 'invalid'] as const;
export type LicenseState = (typeof LICENSE_STATES)[number];

const DAY_MS = 86_400_000;

/** Where a key stands in time (pure): its phase, when the grace ends, whole days to the next edge. */
export const licenseTiming = (
  payload: Pick<LicensePayload, 'expires' | 'grace_days'>,
  now: Date = new Date(),
): { phase: 'valid' | 'expiring' | 'grace' | 'expired'; grace_ends: string | null; days_left: number | null } => {
  if (payload.expires === null) return { phase: 'valid', grace_ends: null, days_left: null };
  const expires = Date.parse(payload.expires);
  const graceEnds = expires + (payload.grace_days ?? DEFAULT_GRACE_DAYS) * DAY_MS;
  const t = now.getTime();
  const grace_ends = new Date(graceEnds).toISOString();
  if (t < expires) {
    const days_left = Math.ceil((expires - t) / DAY_MS);
    return { phase: days_left <= LICENSE_EXPIRING_DAYS ? 'expiring' : 'valid', grace_ends, days_left };
  }
  if (t < graceEnds) return { phase: 'grace', grace_ends, days_left: Math.ceil((graceEnds - t) / DAY_MS) };
  return { phase: 'expired', grace_ends, days_left: 0 };
};

/** The owner console's license card (GET /platform/license). */
export const licenseStatusSchema = z
  .object({
    state: z.enum(LICENSE_STATES),
    problem: z.enum(LICENSE_PROBLEMS).nullable(),
    licensee: z.string().nullable(),
    /** The key's licensed features (in force only in valid / expiring / grace). */
    features: z.array(z.string()),
    expires: z.string().nullable(),
    id: z.string().nullable(),
    issued_at: z.string().nullable(),
    installed_at: z.string().nullable(),
    /** The key's plan (null = a key made before editions, or no key). */
    plan: z.enum(LICENSE_PLANS).nullable(),
    support: z.enum(SUPPORT_LEVELS).nullable(),
    seats: z.number().int().nullable(),
    /** Active users of the installation now (non-guest people with an active membership in any account). */
    seats_used: z.number().int(),
    /** Above the key's seats: a warning only. */
    seats_exceeded: z.boolean(),
    grace_days: z.number().int().nullable(),
    /** When the grace period ends (null = never expires / no key). */
    grace_ends: z.string().nullable(),
    /** Whole days to expiry (valid / expiring) or to the end of grace (grace); null = never. */
    days_left: z.number().int().nullable(),
    /** The installation the key names (null = any). */
    key_instance_id: z.string().nullable(),
    /** This installation's id. */
    instance_id: z.string(),
    /** The last online check of the key (null = never — revocation unknown). */
    checked_at: z.string().nullable(),
    /** The features this version of the code treats as licensed (`EE_FEATURE_KEYS`). */
    ee_features: z.array(z.string()),
  })
  .meta({ id: 'LicenseStatus' });
export type LicenseStatus = z.infer<typeof licenseStatusSchema>;

export const installLicenseSchema = z.object({ key: z.string().trim().min(1).max(20_000) });

/** The license card's banner (null = none): time, revocation, then too many users. */
export const licenseBanner = (s: Pick<LicenseStatus, 'state' | 'seats_exceeded'>) =>
  s.state === 'expiring' || s.state === 'grace' || s.state === 'expired' || s.state === 'revoked'
    ? s.state
    : s.seats_exceeded && s.state === 'valid'
      ? ('seats' as const)
      : null;

/**
 * The licensed features (editions.ts — Registered, Business, Enterprise): unlocked by a valid license key (whole
 * installation) or by a plan version that lists them explicitly (one account) — never by "every feature" (legacy / an
 * empty list), so a self-hosted installation without a key does not get them. Every one of them is new: nothing free
 * today is here. Their code goes in `*.ee.*` files / `ee/` directories (CONTRIBUTING.md).
 */
export const EE_FEATURE_KEYS: readonly string[] = LICENSED_FEATURE_KEYS;

/**
 * The one gate rule the API and the app share: may this feature be used, given the account's plan features
 * (`plan_features`: null = every feature) and the installation's licensed features? A non-licensed feature follows
 * the plan only (`planIncludesFeature`); a licensed one needs the license or an explicit plan listing. `eeKeys`
 * is for tests.
 */
export const featureAllowed = (
  planFeatures: readonly string[] | null | undefined,
  licenseFeatures: readonly string[] | null | undefined,
  key: string,
  eeKeys: readonly string[] = EE_FEATURE_KEYS,
) =>
  eeKeys.includes(key)
    ? !!licenseFeatures?.includes(key) || !!planFeatures?.includes(key)
    : planIncludesFeature(planFeatures, key);
