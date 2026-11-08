// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import {
  DEFAULT_SOURCE_URL,
  AppError,
  DEFAULT_EMAIL_ACCENT,
  DEFAULT_N8N_PACKAGE,
  DEFAULT_LOCALE,
  DEFAULT_TEST_EMAILS_PER_HOUR,
  DEFAULT_AUTOMATION_EMAILS_PER_DAY,
  MAX_PREVIOUS_ORIGINS,
  isLocale,
  mergeNullable,
  platformSettingsSchema,
  resolveIntegrations,
  resolvePublicAddress,
  t,
  type IntegrationsGuide,
  type Locale,
  type PlatformSettings,
  type UpdatePlatformSettings,
} from '@bines/shared';
import { emailSender } from '@bines/server-mail';
import type { Db } from '../../db/client';
import { platformSettings } from '../../db/schema';
import type { AppDeps, SessionUser } from '../../types';
import { getAccountSettings } from '../accounts/accounts.repo';
import { syncBucketCors } from './public-address';

/**
 * Platform-wide settings (owner console → Platform settings; ANSWERS 6א.3/8/9): product name (white-label), the
 * sender of emails of no account, the default SMS sender and the API-token budgets. One row, id `platform`;
 * missing = the defaults. Read on hot paths (every token request), so cached briefly per database handle.
 */
const ROW_ID = 'platform';
const CACHE_MS = 30_000;
const cache = new WeakMap<object, { at: number; value: PlatformSettings }>();

const parse = (raw: unknown): PlatformSettings => {
  const parsed = platformSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : platformSettingsSchema.parse({});
};

export const loadPlatformSettings = async (db: Db): Promise<PlatformSettings> => {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const row = (await db.select().from(platformSettings).where(eq(platformSettings.id, ROW_ID)).limit(1))[0];
  const value = parse(row?.settings);
  cache.set(db, { at: Date.now(), value });
  return value;
};

/** The product's name in a language: the owner's choice, else the i18n catalog's `app.name`. */
export const productName = (settings: PlatformSettings, locale: Locale) =>
  settings.product_name?.trim() || t('app.name', undefined, locale);

/** GET /auth/config: where the running code comes from (AGPL section 13), its version and commit. */
export const platformSource = (settings: PlatformSettings, env: Pick<AppDeps['env'], 'RAILWAY_GIT_COMMIT_SHA'>) => ({
  url: settings.source_url?.trim() || DEFAULT_SOURCE_URL,
  version: process.env.npm_package_version ?? '0.0.0',
  commit: env.RAILWAY_GIT_COMMIT_SHA ? env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7) : null,
});

/** The platform's branding in both UI languages (GET /auth/config: the sign-in screen and the page title). */
export const platformBranding = (settings: PlatformSettings) => ({
  product_name: { he: productName(settings, 'he'), en: productName(settings, 'en') },
  login_subtitle: {
    he: settings.login_subtitle.he?.trim() || null,
    en: settings.login_subtitle.en?.trim() || null,
  },
});

/**
 * The served page's names (apps/api/src/web.ts) before the app knows its reader: the language the browser prefers
 * (Accept-Language), the product name in it; the home-screen title = the owner's phone-app name, else that.
 */
export const webPageNames = (settings: PlatformSettings, acceptLanguage: string | undefined) => {
  const locale =
    (acceptLanguage ?? '')
      .split(',')
      .map((tag) => tag.trim().slice(0, 2).toLowerCase())
      .find(isLocale) ?? DEFAULT_LOCALE;
  const title = productName(settings, locale);
  return { title, appTitle: settings.pwa.app_name ?? title };
};

/** GET /platform/settings: what is saved, and what an empty field falls back to (shown as placeholders). */
export const platformSettingsDto = (
  deps: Pick<AppDeps, 'env'> & Partial<Pick<AppDeps, 'emailEnabled'>>,
  settings: PlatformSettings,
  locale: Locale,
) => ({
  settings,
  email_enabled: deps.emailEnabled !== false,
  fallbacks: {
    product_name: t('app.name', undefined, locale),
    email_address: emailSender(deps.env).address,
    sms_sender_id: deps.env.TEXTME_SENDER_ID ?? null,
    api_docs_logo_url: deps.env.API_DOCS_LOGO_URL ?? null,
    api_docs_brand_color: deps.env.API_DOCS_BRAND_COLOR ?? null,
    email_accent_color: DEFAULT_EMAIL_ACCENT,
    test_emails_per_hour: DEFAULT_TEST_EMAILS_PER_HOUR,
    invite_emails_per_hour: deps.env.INVITE_EMAILS_PER_HOUR,
    automation_emails_per_day: DEFAULT_AUTOMATION_EMAILS_PER_DAY,
    n8n_package: DEFAULT_N8N_PACKAGE,
  },
  public_address: {
    ...resolvePublicAddress(settings.public_address, deps.env),
    env_web_origin: deps.env.WEB_ORIGIN ?? null,
    auth_base_url: deps.env.BETTER_AUTH_URL ?? deps.env.WEB_ORIGIN,
  },
});

export const getPlatformSettings = async (deps: Pick<AppDeps, 'db' | 'env' | 'emailEnabled'>, owner: SessionUser) =>
  platformSettingsDto(deps, await loadPlatformSettings(deps.db), owner.locale === 'en' ? 'en' : 'he');

/**
 * The public address after a change (M11): when the address links are built on moves, the old one is kept among the
 * previous addresses (still accepted for sign-in, CORS and MCP tokens) unless the owner sent that list themselves.
 */
const nextPublicAddress = (
  env: Pick<AppDeps['env'], 'WEB_ORIGIN' | 'BETTER_AUTH_URL'>,
  current: PlatformSettings['public_address'],
  patch: UpdatePlatformSettings['public_address'],
): PlatformSettings['public_address'] => {
  const next = mergeNullable(current, patch);
  if (!patch || patch.previous_origins) return next;
  const before = resolvePublicAddress(current, env).web;
  const after = resolvePublicAddress(next, env).web;
  if (before === after || next.previous_origins.includes(before)) return next;
  return { ...next, previous_origins: [before, ...next.previous_origins].slice(0, MAX_PREVIOUS_ORIGINS) };
};

/** PATCH /platform/settings (platform owner): only what is sent changes; null = back to the default. */
export const updatePlatformSettings = async (
  deps: Pick<AppDeps, 'db' | 'env' | 'logger' | 'storage' | 'emailEnabled'>,
  owner: SessionUser,
  patch: UpdatePlatformSettings,
) => {
  const current = await loadPlatformSettings(deps.db);
  // S-77: never lock out the person turning it on — they must have two-factor sign-in themselves.
  if (patch.security?.console_two_factor && !current.security.console_two_factor && !owner.twoFactorEnabled)
    throw new AppError('invalid_value', 'console_two_factor_needs_yours');
  const top = mergeNullable(current as Record<string, unknown>, {
    product_name: patch.product_name,
    source_url: patch.source_url,
  });
  const next = platformSettingsSchema.parse({
    ...top,
    login_subtitle: mergeNullable(current.login_subtitle, patch.login_subtitle),
    email: mergeNullable(current.email, patch.email),
    sms: mergeNullable(current.sms, patch.sms),
    api_limits: { ...current.api_limits, ...patch.api_limits },
    api_docs: mergeNullable(current.api_docs, patch.api_docs),
    support: {
      ...current.support,
      ...patch.support,
      ...(patch.support?.durations_hours
        ? { durations_hours: [...new Set(patch.support.durations_hours)].sort((x, y) => x - y) }
        : {}),
    },
    senders: mergeNullable(current.senders, patch.senders),
    maps: mergeNullable(current.maps, patch.maps),
    embedding: patch.embedding?.allowed_origins
      ? { allowed_origins: [...new Set(patch.embedding.allowed_origins)] }
      : current.embedding,
    flows: {
      ...current.flows,
      ...(patch.flows?.platforms ? { platforms: [...new Set(patch.flows.platforms)] } : {}),
    },
    ai: { ...current.ai, ...patch.ai },
    pwa: mergeNullable(current.pwa, patch.pwa),
    password: { ...current.password, ...patch.password },
    public_address: nextPublicAddress(deps.env, current.public_address, patch.public_address),
    legal: mergeNullable(current.legal, patch.legal),
    security: { ...current.security, ...patch.security },
    integrations: mergeNullable(current.integrations, patch.integrations),
    account_deletion: { ...current.account_deletion, ...patch.account_deletion },
    retention: { ...current.retention, ...patch.retention },
    // Calendar & holidays: each sent field replaces the stored one (`holidays` = the whole map).
    calendar: { ...current.calendar, ...patch.calendar },
  });
  await deps.db
    .insert(platformSettings)
    .values({ id: ROW_ID, settings: next, updatedBy: owner.id })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { settings: next, updatedBy: owner.id, updatedAt: new Date() },
    });
  cache.delete(deps.db);
  // M11: the file bucket follows the public address (best effort, only when S3_SET_CORS — never fails the save).
  if (patch.public_address) await syncBucketCors(deps);
  // No account to audit in: the owner's change is logged with what moved (never secrets — there are none here).
  deps.logger.info({ owner: owner.id, fields: Object.keys(patch) }, 'platform settings updated');
  return getPlatformSettings(deps, owner);
};

/**
 * GET /auth/integrations: what a member needs to connect n8n / Make — the product name, the address
 * to paste as "Instance URL" (the API's public origin), the n8n package and the Make app's invitation link.
 */
export const integrationsGuide = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  locale: Locale,
): Promise<IntegrationsGuide> => {
  const settings = await loadPlatformSettings(deps.db);
  const base = resolvePublicAddress(settings.public_address, deps.env).api;
  return {
    product_name: productName(settings, locale),
    base_url: base,
    api_base: `${base}/api/v1`,
    ...resolveIntegrations(settings.integrations),
  };
};

/**
 * The SMS sender id of an account (ANSWERS 6א.8): its own, else the platform's; undefined = the sender's fallback
 * (TEXTME_SENDER_ID). Never a brand literal.
 */
export const smsSenderId = async (db: Db, accountId?: string | null): Promise<string | undefined> => {
  if (accountId) {
    const settings = (await getAccountSettings(db, accountId)) as { sms?: { sender_id?: unknown } };
    const own = settings.sms?.sender_id;
    if (typeof own === 'string' && own.trim()) return own.trim();
  }
  return (await loadPlatformSettings(db)).sms.sender_id;
};
