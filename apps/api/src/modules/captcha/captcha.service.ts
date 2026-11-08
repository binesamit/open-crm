// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import {
  type AccountCaptcha,
  type AccountCaptchaConfig,
  accountCaptchaConfigSchema,
  AppError,
  type AuthCaptcha,
  captchaWanted,
  type FormAccountCaptcha,
  type PlatformCaptcha,
  type PlatformCaptchaConfig,
  platformCaptchaConfigSchema,
  type PlatformCaptchaSurface,
  type UpdateAccountCaptcha,
  type UpdatePlatformCaptcha,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { platformSettings } from '../../db/schema';
import type { AppDeps, RequestMeta, SessionUser } from '../../types';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';
import { recordEvent } from '../activity/activity.repo';
import { recordAudit } from '../audit/audit.repo';
import { type AdminActor } from '../admin/security.service';
import { turnstile } from '../forms/forms.turnstile';
import { assertAccountAdmin } from '../../lib/account-admin';

/**
 * Cloudflare Turnstile in layers. The account's keys and master switch live in
 * `account_settings.settings.captcha` (Administration → Security), the platform's in the `platform_settings` row
 * `captcha` (owner console). Secrets are sealed with the secret box and never leave the server. Each public place
 * resolves its own mode (`inherit` / `on` / `off`) against the level above; with no keys nothing is checked.
 */
type Stored<C> = C & { secret_sealed?: string };
/** The keys a check runs with (null = no check). */
export type CaptchaKeys = { site_key: string; secret_sealed: string };

const PLATFORM_ROW = 'captcha';
const CACHE_MS = 30_000;
const platformCache = new WeakMap<object, { at: number; value: Stored<PlatformCaptchaConfig> }>();

const sealedOf = (raw: unknown) => {
  const v = (raw as { secret_sealed?: unknown } | null | undefined)?.secret_sealed;
  return typeof v === 'string' && v ? v : undefined;
};

const parseAccount = (raw: unknown): Stored<AccountCaptchaConfig> => {
  const parsed = accountCaptchaConfigSchema.safeParse(raw ?? {});
  const config = parsed.success ? parsed.data : accountCaptchaConfigSchema.parse({});
  const sealed = sealedOf(raw);
  return sealed ? { ...config, secret_sealed: sealed } : config;
};
const parsePlatform = (raw: unknown): Stored<PlatformCaptchaConfig> => {
  const parsed = platformCaptchaConfigSchema.safeParse(raw ?? {});
  const config = parsed.success ? parsed.data : platformCaptchaConfigSchema.parse({});
  const sealed = sealedOf(raw);
  return sealed ? { ...config, secret_sealed: sealed } : config;
};

const keysOf = (c: { site_key: string; secret_sealed?: string }): CaptchaKeys | null =>
  c.site_key && c.secret_sealed ? { site_key: c.site_key, secret_sealed: c.secret_sealed } : null;

const dto = <C extends { site_key: string; secret_sealed?: string }>(c: C) => {
  const { secret_sealed, ...rest } = c;
  return { ...rest, secret_set: !!secret_sealed, keys_ready: !!keysOf(c) };
};

/** The next stored config from a patch — "on" anywhere needs both keys (400 `invalid_value` captcha_keys_missing). */
const merge = <C extends { enabled: boolean; site_key: string; surfaces: Record<string, string> }>(
  secrets: AppDeps['secrets'],
  current: Stored<C>,
  patch: {
    enabled?: boolean;
    site_key?: string;
    secret?: string | null;
    surfaces?: Partial<Record<string, string | undefined>>;
  },
): Stored<C> => {
  const surfaces = { ...current.surfaces };
  for (const [k, v] of Object.entries(patch.surfaces ?? {})) if (v !== undefined) surfaces[k] = v;
  const { secret_sealed: _old, ...base } = current;
  const sealed =
    patch.secret === undefined ? current.secret_sealed : patch.secret === null ? undefined : secrets.seal(patch.secret);
  const next = {
    ...base,
    enabled: patch.enabled ?? current.enabled,
    site_key: patch.site_key ?? current.site_key,
    surfaces,
    ...(sealed ? { secret_sealed: sealed } : {}),
  } as Stored<C>;
  const wantsOn = next.enabled || Object.values(surfaces).includes('on');
  if (wantsOn && !keysOf(next)) throw new AppError('invalid_value', 'captcha_keys_missing', { field: 'captcha' });
  return next;
};

// ---------------------------------------------------------------- account

export const loadAccountCaptcha = async (db: Db, accountId: string) =>
  parseAccount(((await getAccountSettings(db, accountId)) as { captcha?: unknown }).captcha);

/** GET /security/captcha (admin). */
export const getAccountCaptcha = async (deps: Pick<AppDeps, 'db'>, a: AdminActor): Promise<AccountCaptcha> => {
  assertAccountAdmin(a.ctx);
  return dto(await loadAccountCaptcha(deps.db, a.ctx.accountId));
};

/** PATCH /security/captcha (admin): one `account.updated` event and a `security.captcha_changed` audit row. */
export const updateAccountCaptcha = async (
  deps: Pick<AppDeps, 'db' | 'secrets'>,
  a: AdminActor,
  patch: UpdateAccountCaptcha,
  meta: RequestMeta,
): Promise<AccountCaptcha> => {
  assertAccountAdmin(a.ctx);
  return deps.db.transaction(async (tx) => {
    const settings = (await getAccountSettings(tx, a.ctx.accountId)) as Record<string, unknown>;
    const current = parseAccount(settings.captcha);
    const next = merge(deps.secrets, current, patch);
    await upsertAccountSettings(tx, a.ctx.accountId, { ...settings, captcha: next }, a.user.id);
    // Never the secret — only whether one is set.
    const before = dto(current);
    const after = dto(next);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'account.updated',
      actorId: a.user.id,
      requestId: a.requestId ?? meta.requestId,
      before: { captcha: before },
      after: { captcha: after },
    });
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'security.captcha_changed',
      targetType: 'account',
      targetId: a.ctx.accountId,
      payload: { before, after, secret_changed: patch.secret !== undefined },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return after;
  });
};

// ---------------------------------------------------------------- platform

export const loadPlatformCaptcha = async (db: Db) => {
  const hit = platformCache.get(db);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const row = (await db.select().from(platformSettings).where(eq(platformSettings.id, PLATFORM_ROW)).limit(1))[0];
  const value = parsePlatform(row?.settings);
  platformCache.set(db, { at: Date.now(), value });
  return value;
};

/** GET /platform/captcha (platform owner). */
export const getPlatformCaptcha = async (deps: Pick<AppDeps, 'db'>): Promise<PlatformCaptcha> =>
  dto(await loadPlatformCaptcha(deps.db));

/** PATCH /platform/captcha (platform owner). No account to audit in: logged with what moved (never the secret). */
export const updatePlatformCaptcha = async (
  deps: Pick<AppDeps, 'db' | 'secrets' | 'logger'>,
  owner: SessionUser,
  patch: UpdatePlatformCaptcha,
): Promise<PlatformCaptcha> => {
  platformCache.delete(deps.db);
  const next = merge(deps.secrets, await loadPlatformCaptcha(deps.db), patch);
  await deps.db
    .insert(platformSettings)
    .values({ id: PLATFORM_ROW, settings: next, updatedBy: owner.id })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { settings: next, updatedBy: owner.id, updatedAt: new Date() },
    });
  platformCache.delete(deps.db);
  deps.logger.info(
    { owner: owner.id, fields: Object.keys(patch).map((k) => (k === 'secret' ? 'secret(changed)' : k)) },
    'platform captcha updated',
  );
  return dto(next);
};

/** The keys a platform place checks with, or null (off, or no keys). */
export const platformCaptchaKeys = async (db: Db, surface: PlatformCaptchaSurface) => {
  const c = await loadPlatformCaptcha(db);
  const keys = keysOf(c);
  return keys && captchaWanted(c.surfaces[surface], c.enabled) ? keys : null;
};

/** The platform's keys whatever the places' modes say, or null (self sign-up makes the check mandatory, D32). */
export const platformCaptchaAnyKeys = async (db: Db) => keysOf(await loadPlatformCaptcha(db));

/** GET /auth/config → `captcha`: the sign-in screens learn which of them ask for the check. */
export const authCaptchaConfig = async (db: Db): Promise<AuthCaptcha> => {
  const c = await loadPlatformCaptcha(db);
  const ready = !!keysOf(c);
  const on = (s: PlatformCaptchaSurface) => ready && captchaWanted(c.surfaces[s], c.enabled);
  return {
    site_key: ready && (on('sign_in') || on('sign_up') || on('forgot_password')) ? c.site_key : null,
    sign_in: on('sign_in'),
    sign_up: on('sign_up'),
    forgot_password: on('forgot_password'),
  };
};

// ---------------------------------------------------------------- forms

/** What `inherit` means for a form of this account, and whether the account has keys. */
export const formAccountCaptcha = (account: Stored<AccountCaptchaConfig>): FormAccountCaptcha => ({
  keys_ready: !!keysOf(account),
  inherited: captchaWanted(account.surfaces.forms, account.enabled),
});

/**
 * The keys a form checks with, or null. Its own mode decides (`inherit` → the account's); the keys are the form's
 * own when it has both, else the account's.
 */
export const formCaptchaKeys = async (
  db: Db,
  form: { accountId: string; mode: AccountCaptchaConfig['surfaces']['forms']; own: CaptchaKeys | null },
): Promise<CaptchaKeys | null> => {
  const account = await loadAccountCaptcha(db, form.accountId);
  if (!captchaWanted(form.mode, formAccountCaptcha(account).inherited)) return null;
  return form.own ?? keysOf(account);
};

// ---------------------------------------------------------------- the check

/**
 * Throws 400 `captcha_required` (no token) or `captcha_failed` (Cloudflare said no, or could not be reached) when
 * `keys` is set; nothing to do without keys.
 */
export const assertCaptcha = async (
  secrets: AppDeps['secrets'],
  keys: CaptchaKeys | null,
  token: string | null | undefined,
  ip: string | null,
) => {
  if (!keys) return;
  if (!token?.trim()) throw new AppError('captcha_required', 'The anti-spam check is required');
  const ok = await turnstile.verify(secrets.open(keys.secret_sealed), token.trim(), ip);
  if (!ok) throw new AppError('captcha_failed', 'The anti-spam check failed');
};
