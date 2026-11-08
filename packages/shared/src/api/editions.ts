// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Editions (docs/LICENSING.md, the approved licensing model, part A): what each edition of a self-hosted installation
 * gets — as data, the one place the code names it.
 *
 * Golden rule (D29): a feature that is free today stays free forever. Everything the product has today is
 * Community (`COMMUNITY_CAPABILITIES` — descriptive only: nothing there is ever gated by a license). A license key
 * unlocks only the keys below, and every one of them is a feature that does not exist yet (or, for the Registered
 * conveniences, exists only as its gate). The owner console and white-label stay Community.
 *
 * Nothing is locked (D33): every installation has every capability with no key. A key is a provider's record:
 * - Unregistered: no key at all — the normal state of an installation.
 * - Registered: a free key from a provider the owner chose (no expiry).
 * - Business / Enterprise: the provider's paid support offers (yearly keys).
 */

export const EDITIONS = ['unregistered', 'registered', 'business', 'enterprise'] as const;
export type Edition = (typeof EDITIONS)[number];

/** The plans a license key can carry (Community needs no key). */
export const LICENSE_PLANS = ['registered', 'business', 'enterprise'] as const;
export type LicensePlan = (typeof LICENSE_PLANS)[number];

/** The support level a key names (shown in the owner console; it unlocks no code). */
export const SUPPORT_LEVELS = ['community', 'standard', 'sla'] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

/** What exists today — all Community, in every edition (shown on the editions table; never gated by a license). */
export const COMMUNITY_CAPABILITIES = [
  'boards',
  'automations',
  'ai',
  'docs_dashboards_forms',
  'guests_portal',
  'api_integrations',
  'extensions',
  'social_sign_in_2fa',
  'audit_errors_secrets',
  'owner_console_white_label',
] as const;
export type CommunityCapability = (typeof COMMUNITY_CAPABILITIES)[number];

/** Registered: small conveniences (gated; built beyond the gate later). */
export const REGISTERED_FEATURE_KEYS = ['template_library', 'update_check', 'scheduled_backup'] as const;
/** Business (and Enterprise): enterprise sign-in and team scale — none built yet. */
export const BUSINESS_FEATURE_KEYS = ['saml', 'oidc', 'scim', 'environments', 'custom_roles'] as const;
/** Enterprise only: governance, scale and hosting for others — none built yet. */
export const ENTERPRISE_FEATURE_KEYS = ['log_streaming', 'external_secrets', 'multi_api', 'embed'] as const;

/** Every feature a license key can unlock. */
export const LICENSED_FEATURE_KEYS = [
  ...REGISTERED_FEATURE_KEYS,
  ...BUSINESS_FEATURE_KEYS,
  ...ENTERPRISE_FEATURE_KEYS,
] as const;
export type LicensedFeatureKey = (typeof LICENSED_FEATURE_KEYS)[number];

/** The feature keys a key of each plan may list (none is built or gated: `LICENSED_FEATURES_BUILT`). */
export const EDITION_FEATURES: Readonly<Record<Edition, readonly LicensedFeatureKey[]>> = {
  unregistered: [],
  registered: [...REGISTERED_FEATURE_KEYS],
  business: [...REGISTERED_FEATURE_KEYS, ...BUSINESS_FEATURE_KEYS],
  enterprise: [...LICENSED_FEATURE_KEYS],
};

/** The support level each edition comes with (an issued key may name another). */
export const EDITION_SUPPORT: Readonly<Record<Edition, SupportLevel>> = {
  unregistered: 'community',
  registered: 'community',
  business: 'standard',
  enterprise: 'sla',
};

/** Features that are only a gate today (nothing behind them yet) — the console marks them "coming". */
export const LICENSED_FEATURES_BUILT: readonly LicensedFeatureKey[] = [];

/** Grace after a key's expiry, in days, when the key does not say (part B). */
export const DEFAULT_GRACE_DAYS = 14;
/** The console warns this many days before a key expires. */
export const LICENSE_EXPIRING_DAYS = 30;
/** Business / Enterprise keys run a year; a renewal adds one. */
export const LICENSE_TERM_DAYS = 365;
