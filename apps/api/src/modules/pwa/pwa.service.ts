// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AccountSettings,
  AppError,
  DEFAULT_PWA_THEME,
  isId,
  type MessageKey,
  type PlatformSettings,
  type PushSubscriptionInput,
  type PushSubscriptionRow,
  type PwaConfig,
  type PwaIcon,
  type PwaStartPage,
  PWA_BREAKING_EPOCH,
  pwaIconSize,
  t,
} from '@bines/shared';
import { accountClosed } from '../billing/entitlements';
import type { AccountContext, AppDeps, SessionUser, Actor as BaseActor } from '../../types';
import type { AccountRow } from '../accounts/accounts.repo';
import { findAccountById } from '../accounts/accounts.repo';
import { loadSettings, MAX_LOGO_BYTES } from '../accounts/accounts.service';
import { assetsByIds } from '../files/files.repo';
import { loadPlatformSettings, productName } from '../platform/platform-settings';
import { summaryOf } from '../updates/device';
import { cachedIcon, decodeImage, defaultIcon, logoIcon } from './icons';
import { deleteEndpointForUser, deleteSubscription, listSubscriptions, upsertSubscription } from './pwa.repo';
import { serverBuild } from './build';
import { loadVapid } from './vapid';

type Deps = Pick<AppDeps, 'db' | 'env' | 'storage'>;

/** Where the public files of an account (or of the platform, without one) live. */
const PUBLIC_BASE = '/api/v1/public/pwa';
const baseOf = (accountId: string | null) => (accountId ? `${PUBLIC_BASE}/a/${accountId}` : PUBLIC_BASE);

const START_PATH: Record<PwaStartPage, string> = { my_work: '/my-work', home: '', inbox: '/inbox' };

/** The colour: the account's, else the owner's default, else the built-in one. */
const themeOf = (platform: PlatformSettings, settings: AccountSettings | null) =>
  settings?.pwa.theme_color ?? platform.pwa.theme_color ?? DEFAULT_PWA_THEME;

const nameOf = (platform: PlatformSettings, account: AccountRow | null, settings: AccountSettings | null) =>
  settings?.pwa.app_name ??
  account?.name ??
  platform.pwa.app_name ??
  productName(platform, settings?.locale.language === 'en' ? 'en' : 'he');

/** Icons change when the logo or the colour does: the version goes into their address (cached a day). */
const iconVersion = (account: AccountRow | null, theme: string) =>
  encodeURIComponent(`${account?.logoAssetId ?? 'none'}-${theme.replace('#', '')}`);

/** An account a browser may install: exists and is neither suspended nor closed (anything else is 404). */
const installable = async (deps: Deps, accountId: string) => {
  const account = isId(accountId) ? await findAccountById(deps.db, accountId) : undefined;
  // plan-lock: a closed account installs nothing either.
  if (!account || account.status === 'suspended' || (await accountClosed(deps.db, account.id)))
    throw new AppError('not_found', 'No such app');
  return { account, settings: await loadSettings(deps.db, account.id) };
};

/**
 * The web app manifest (PWA פ1): the account's name, colour, icons and first screen — or the platform's (the
 * sign-in page). `id` is per account, so someone in two accounts can install two apps.
 */
export const buildManifest = async (deps: Deps, accountId: string | null) => {
  const platform = await loadPlatformSettings(deps.db);
  const { account, settings } = accountId ? await installable(deps, accountId) : { account: null, settings: null };
  const theme = themeOf(platform, settings);
  const name = nameOf(platform, account, settings);
  const lang = settings?.locale.language ?? 'he';
  const v = iconVersion(account, theme);
  const icon = (file: PwaIcon, purpose: 'any' | 'maskable') => ({
    src: `${baseOf(account?.id ?? null)}/icon/${file}.png?v=${v}`,
    sizes: `${pwaIconSize(file)}x${pwaIconSize(file)}`,
    type: 'image/png',
    purpose,
  });
  const root = account ? `/a/${account.slug}` : '';
  return {
    id: account ? `/a/${account.slug}/` : '/',
    name,
    short_name: name.length > 12 ? name.slice(0, 12).trim() : name,
    lang,
    dir: lang === 'he' ? 'rtl' : 'ltr',
    start_url: `${root}${settings ? START_PATH[settings.pwa.start_page] : ''}` || '/',
    scope: '/',
    display: 'standalone',
    background_color: theme,
    theme_color: theme,
    icons: [icon('192', 'any'), icon('512', 'any'), icon('maskable-512', 'maskable')],
  };
};

/** One icon file: the account's logo on a tile, or the neutral mark in the colour. */
export const renderIcon = async (deps: Deps, accountId: string | null, file: PwaIcon) => {
  const platform = await loadPlatformSettings(deps.db);
  const { account, settings } = accountId ? await installable(deps, accountId) : { account: null, settings: null };
  const theme = themeOf(platform, settings);
  const fallback = () => cachedIcon(`default:${theme}:${file}`, () => defaultIcon(theme, file));
  const logoId = account?.logoAssetId;
  if (!account || !logoId) return fallback();
  const key = `logo:${logoId}:${file}`;
  const [asset] = await assetsByIds(deps.db, account.id, [logoId]);
  if (!asset?.storageKey) return fallback();
  let bytes: Buffer | null = null;
  try {
    bytes = await deps.storage.get(asset.storageKey, MAX_LOGO_BYTES + 1024);
  } catch {
    bytes = null;
  }
  const img = bytes ? decodeImage(bytes) : null;
  // A logo we cannot draw is not read again on every request: its key holds the neutral mark.
  return cachedIcon(key, () => (img ? logoIcon(img, file) : defaultIcon(theme, file)));
};

/**
 * The kill switch, the web build this server serves and its breaking epoch (the service worker and the page read
 * it: another build = "a new version — refresh"; a higher epoch than the page's = "must refresh to continue").
 */
export const pwaStatus = async (deps: Deps) => ({
  sw_enabled: (await loadPlatformSettings(deps.db)).pwa.sw_enabled,
  build: serverBuild(),
  breaking_epoch: PWA_BREAKING_EPOCH,
});

const pushOn = (platform: PlatformSettings, settings: AccountSettings) =>
  platform.pwa.push_enabled && settings.pwa.push_enabled;

/** GET /pwa/config: what the app needs inside this account (push key only when push is on here). */
export const pwaConfig = async (deps: Deps, ctx: AccountContext): Promise<PwaConfig> => {
  const platform = await loadPlatformSettings(deps.db);
  const settings = await loadSettings(deps.db, ctx.accountId);
  const push = pushOn(platform, settings);
  const theme = themeOf(platform, settings);
  const v = iconVersion(ctx.account, theme);
  return {
    push_enabled: push,
    vapid_public_key: push ? (await loadVapid(deps.db, deps.env)).publicKey : null,
    install_prompt: settings.pwa.install_prompt,
    install_prompt_after: settings.pwa.install_prompt_after,
    manifest_url: `${baseOf(ctx.accountId)}/manifest.webmanifest`,
    apple_icon_url: `${baseOf(ctx.accountId)}/icon/apple-180.png?v=${v}`,
    favicon_url: `${baseOf(ctx.accountId)}/icon/favicon-32.png?v=${v}`,
    theme_color: theme,
    app_name: nameOf(platform, ctx.account, settings),
  };
};

type Actor = BaseActor & { sessionId: string | null };
const dto = (r: Awaited<ReturnType<typeof listSubscriptions>>[number], endpoint?: string): PushSubscriptionRow => ({
  id: r.id,
  device_label: r.deviceLabel,
  created_at: r.createdAt.toISOString(),
  last_used_at: r.lastUsedAt?.toISOString() ?? null,
  current: !!endpoint && r.endpoint === endpoint,
});

export const mySubscriptions = async (deps: Deps, a: Actor, endpoint?: string) => ({
  data: (await listSubscriptions(deps.db, a.ctx.accountId, a.user.id)).map((r) => dto(r, endpoint)),
});

/** POST /me/push-subscriptions: this browser gets my notifications on the phone channel in this account. */
export const subscribe = async (deps: Deps, a: Actor, input: PushSubscriptionInput, userAgent: string | undefined) => {
  const platform = await loadPlatformSettings(deps.db);
  if (!pushOn(platform, await loadSettings(deps.db, a.ctx.accountId))) throw new AppError('forbidden', 'push_disabled');
  // Guests may get push too: the worker sends only what the bell would show them.
  const row = await upsertSubscription(deps.db, {
    accountId: a.ctx.accountId,
    userId: a.user.id,
    sessionId: a.sessionId,
    endpoint: input.endpoint,
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
    deviceLabel: (input.device_label || summaryOf(userAgent ?? '') || t('pwa.device.unknown' as MessageKey)).slice(
      0,
      80,
    ),
  });
  return dto(row, input.endpoint);
};

export const unsubscribe = async (deps: Deps, a: Actor, id: string) => {
  if (!(await deleteSubscription(deps.db, a.ctx.accountId, a.user.id, id)))
    throw new AppError('not_found', 'No such device');
  return { ok: true as const };
};

/** Sign-out (or "turn off on this phone" everywhere): this endpoint leaves all my accounts. */
export const unsubscribeEndpoint = async (deps: Deps, user: SessionUser, endpoint: string) => ({
  ok: true as const,
  removed: await deleteEndpointForUser(deps.db, user.id, endpoint),
});
