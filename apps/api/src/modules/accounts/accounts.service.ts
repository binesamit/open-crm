// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  accountDefaultsOf,
  accountSettingsSchema,
  canAccount,
  DEFAULT_EMAIL_ACCENT,
  DEFAULT_MAIL_STYLE,
  defaultAccountSettings,
  isId,
  mergeNullable,
  newId,
  rankBetween,
  resolveCalendar,
  type TemplateSet,
} from '@bines/shared';
import { accountClosed } from '../billing/entitlements';
import type {
  AccountCalendarSettings,
  Announcement,
  AnnouncementInput,
  Locale,
  PlatformCalendarSettings,
  UpdateAccount,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { imageLink, isInlineSafeMime } from '../../lib/storage';
import { recordEvent } from '../activity/activity.repo';
import { recordAudit } from '../audit/audit.repo';
import { installStarterPack } from '../extensions/starter';
import { forgetApiLimits } from '../tokens/tokens.service';
import { st } from '../../lib/i18n';
import { loadPlatformSettings, productName } from '../platform/platform-settings';
import { resolveStarterKit } from '../extensions/packs';
import { routeSenderChanges } from '../senders/senders.service';
import { assetsByIds } from '../files/files.repo';
import { ownUploadedAssets } from '../files/files.service';
import { imagePixels, MAX_IMAGE_PIXELS } from '../pwa/icons';
import type { AccountContext, AppDeps, RequestMeta, Actor } from '../../types';
import {
  type AccountRow,
  findAccountById,
  findAccountBySlug,
  getAccountSettings,
  insertAccount,
  insertWorkspace,
  updateAccountRow,
  upsertAccountSettings,
} from './accounts.repo';
import { assertAccountAdmin } from '../../lib/account-admin';

export type ProvisionInput = {
  name: string;
  slug: string;
  templateSet: TemplateSet;
  timezone?: string;
  currency?: string;
  createdBy: string | null;
  /** Who opened it (D32): the owner console by default; `signup` for a self sign-up. */
  origin?: 'owner' | 'setup' | 'signup';
  /** Its admin opens with "How to start?". */
  onboarding?: boolean;
};

/**
 * Creates an account with its settings, its first workspace and opening kit (D12). Must run inside a transaction.
 * The kit is a data pack from the platform catalog (D27 ת1, seed/packs): its workspace name, folders and boards —
 * installed as the account's own installation, so it shows in Administration → Extensions. `empty` = a workspace
 * named in the account's language (i18n `server.mainWorkspace`) and nothing else.
 */
export const provisionAccount = async (tx: Db, input: ProvisionInput): Promise<AccountRow> => {
  if (await findAccountBySlug(tx, input.slug)) throw new AppError('slug_taken', `Slug "${input.slug}" is taken`);
  const kit = await resolveStarterKit(tx, input.templateSet);

  const id = newId();
  await insertAccount(tx, {
    id,
    name: input.name,
    slug: input.slug,
    createdBy: input.createdBy,
    ...(input.origin ? { origin: input.origin } : {}),
  });
  const settings = defaultAccountSettings({ timezone: input.timezone, currency: input.currency });
  if (input.onboarding) settings.onboarding = { status: 'pending', choice: null, done_at: null, sample_item_ids: [] };
  await upsertAccountSettings(tx, id, settings, input.createdBy ?? undefined);

  const workspaceId = newId();
  await insertWorkspace(tx, {
    id: workspaceId,
    accountId: id,
    // A kit names the first workspace, or leaves it to the account's own name (M11 stage 3 — no name in code);
    // no kit = the account language's "main workspace".
    name: kit
      ? (kit.data?.starter_kit?.workspace_name ?? input.name)
      : st('server.mainWorkspace', undefined, settings.locale.language),
    kind: 'open',
    position: rankBetween(null, null),
    createdBy: input.createdBy,
  });
  // Boards from the kit's templates. No board owner: the account creator (often the platform owner) is not a
  // member of the new account; its admins manage every board (05 §10).
  if (kit) await installStarterPack(tx, { accountId: id, workspaceId, manifest: kit });

  const created = await findAccountBySlug(tx, input.slug);
  return created!;
};

/** The account's settings, its defaults in its language where it never set them (`accountDefaultsOf`). */
export const loadSettings = async (db: Db, accountId: string) => {
  const stored = await getAccountSettings(db, accountId);
  return { ...accountSettingsSchema.parse(stored), defaults: accountDefaultsOf(stored) };
};

export const accountDto = (account: AccountRow) => ({
  id: account.id,
  name: account.name,
  slug: account.slug,
  status: account.status,
});

/** Logos are small marks (sidebar, switcher, email): 2 MB is plenty. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TTL = 60 * 60; // seconds

type Deps = Pick<AppDeps, 'db' | 'storage'>;
/** A short-lived signed URL of the account's logo, or null. */
export const accountLogoUrl = async (deps: Deps, accountId: string, assetId: string | null) => {
  if (!assetId) return null;
  const [asset] = await assetsByIds(deps.db, accountId, [assetId]);
  if (!asset?.storageKey) return null;
  // A logo saved before S-14 may be an SVG: then it downloads instead of rendering from the storage origin.
  return imageLink(deps.storage, asset.storageKey, asset.fileName || 'logo', {
    inline: isInlineSafeMime(asset.mime),
    ttl: LOGO_TTL,
  });
};

/** What empty account settings fall back to (owner console), for the admin's placeholders. */
const platformDefaults = async (db: Db, locale: Locale) => {
  const p = await loadPlatformSettings(db);
  return {
    product_name: productName(p, locale),
    sms_sender_id: p.sms.sender_id ?? null,
    api_limits: p.api_limits,
    email_accent_color: p.email.accent_color ?? DEFAULT_EMAIL_ACCENT,
    email_style: p.email.style ?? DEFAULT_MAIL_STYLE,
    calendar: p.calendar,
    inbound_domain: p.email.inbound_domain ?? null,
  };
};

/**
 * The account's calendar after a PATCH: a null field goes back to the platform's, `holidays` and
 * `custom_days` replace the stored ones. A holiday the owner locked is never stored for the account (dropped).
 */
const nextCalendar = (
  current: AccountCalendarSettings,
  patch: NonNullable<UpdateAccount['settings']>['calendar'],
  platform: PlatformCalendarSettings,
): AccountCalendarSettings => {
  const next = mergeNullable(current, patch);
  const locked = new Set(
    Object.entries(platform.holidays)
      .filter(([, h]) => h.locked)
      .map(([k]) => k),
  );
  return { ...next, holidays: Object.fromEntries(Object.entries(next.holidays).filter(([k]) => !locked.has(k))) };
};

/** A settings object without its sealed / encrypted values (`*_sealed`, `*_enc`), at any depth. */
const withoutSealed = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutSealed)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([k]) => !/_(sealed|enc)$/.test(k))
            .map(([k, v]) => [k, withoutSealed(v)]),
        )
      : value;

export const getAccountDetail = async (deps: Deps, ctx: AccountContext) => {
  const decision = canAccount(ctx.role, 'account.read');
  if (!decision.ok) throw new AppError('forbidden', decision.reason);
  const settings = await loadSettings(deps.db, ctx.accountId);
  const platform = await loadPlatformSettings(deps.db);
  // Guests see only presentation settings (05 §2.1): branding, locale and the announcement. Members and viewers
  // what the app needs to work for them — never the modules' blobs (security / IP allow-list, SSO, support, captcha,
  // AI, helpdesk …, audit 2026-10-10 #2). Admins everything but sealed secrets.
  const visible =
    ctx.role === 'guest'
      ? accountSettingsSchema.parse({
          branding: settings.branding,
          locale: settings.locale,
          announcement: settings.announcement,
        })
      : ctx.role === 'admin'
        ? (withoutSealed(settings) as typeof settings)
        : accountSettingsSchema.parse({
            branding: settings.branding,
            locale: settings.locale,
            announcement: settings.announcement,
            permissions: settings.permissions,
            defaults: settings.defaults,
            idoc_themes: settings.idoc_themes,
            notifications: settings.notifications,
            hidden_templates: settings.hidden_templates,
            maps: settings.maps,
            pwa: settings.pwa,
          });
  return {
    ...accountDto(ctx.account),
    settings: visible,
    logo_url: await accountLogoUrl(deps, ctx.accountId, ctx.account.logoAssetId),
    // Admins only: the separate email logo (null = emails use the account logo).
    email_logo_url:
      ctx.role === 'admin'
        ? await accountLogoUrl(deps, ctx.accountId, settings.branding.email_logo_asset_id ?? null)
        : null,
    platform_defaults: ctx.role === 'admin' ? await platformDefaults(deps.db, settings.locale.language) : null,
    // Every member: the calendar the account works by — Hebrew dates, holidays, working days.
    calendar: resolveCalendar(platform.calendar, settings.calendar),
    created_at: ctx.account.createdAt.toISOString(),
  };
};

/** The announcement as stored: a new id whenever what members see changes (so a dismissed banner shows again). */
const nextAnnouncement = (current: Announcement | null, input: AnnouncementInput | undefined): Announcement | null => {
  if (input === undefined) return current;
  if (input === null) return null;
  if (current && current.text === input.text && current.url === input.url && current.until === input.until)
    return current;
  return {
    id: newId(),
    text: input.text,
    ...(input.url ? { url: input.url } : {}),
    ...(input.until ? { until: input.until } : {}),
    updated_at: new Date().toISOString(),
  };
};

/** What moved between two snapshots: the event's before / after hold only the keys that changed. */
const diff = (before: Record<string, unknown>, after: Record<string, unknown>) => {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k] ?? null;
      a[k] = after[k] ?? null;
    }
  }
  return { before: b, after: a };
};

/** One `account.updated` activity event and one audit row (08 §11). */
const recordChange = async (
  tx: Db,
  a: Actor,
  meta: RequestMeta,
  change: { before: Record<string, unknown>; after: Record<string, unknown> },
) => {
  await recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'account.updated',
    actorId: a.user.id,
    requestId: a.requestId ?? meta.requestId,
    before: change.before,
    after: change.after,
  });
  await recordAudit(tx, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action: 'account.updated',
    targetType: 'account',
    targetId: a.ctx.accountId,
    payload: { fields: Object.keys(change.after) },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
};

/**
 * PATCH /accounts/me (admins, 08 §2): the name and the settings — locale, portal name, permissions, notification
 * defaults, defaults for new boards / groups / columns and the announcement. Only what was sent changes; one
 * `account.updated` event (and an audit row) with what moved.
 */
export const updateAccount = async (deps: Deps, a: Actor, input: UpdateAccount, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx);
  const { db } = deps;
  await db.transaction(async (tx) => {
    const current = await loadSettings(tx, a.ctx.accountId);
    const before: Record<string, unknown> = { name: a.ctx.account.name };
    const after: Record<string, unknown> = { name: input.name ?? a.ctx.account.name };
    if (input.name && input.name !== a.ctx.account.name)
      await updateAccountRow(tx, a.ctx.accountId, { name: input.name });
    // Custom senders wait for the platform owner (S-46): they leave the patch as pending requests.
    const s = input.settings
      ? (
          await routeSenderChanges(
            tx,
            { accountId: a.ctx.accountId, accountName: input.name ?? a.ctx.account.name, userId: a.user.id },
            current,
            input.settings,
            meta,
          )
        ).patch
      : undefined;
    if (s) {
      const next = accountSettingsSchema.parse({
        ...current,
        locale: { ...current.locale, ...s.locale },
        branding: mergeNullable(current.branding, s.branding),
        sms: mergeNullable(
          current.sms,
          s.sms?.limits ? { ...s.sms, limits: { ...current.sms.limits, ...s.sms.limits } } : s.sms,
        ),
        api_limits: mergeNullable(current.api_limits, s.api_limits),
        permissions: { ...current.permissions, ...s.permissions },
        notifications: { ...current.notifications, ...s.notifications },
        defaults: { ...current.defaults, ...s.defaults },
        idoc_themes: { ...current.idoc_themes, ...s.idoc_themes },
        invitations: { ...current.invitations, ...s.invitations },
        session_checks: { ...current.session_checks, ...s.session_checks },
        downloads: { ...current.downloads, ...s.downloads },
        tours: { ...current.tours, ...s.tours },
        inbound_email: { ...current.inbound_email, ...s.inbound_email },
        pwa: mergeNullable(current.pwa, s.pwa),
        announcement: nextAnnouncement(current.announcement, s.announcement),
        domains: s.domains ?? current.domains,
        calendar: s.calendar
          ? nextCalendar(current.calendar, s.calendar, (await loadPlatformSettings(tx)).calendar)
          : current.calendar,
      });
      await upsertAccountSettings(tx, a.ctx.accountId, next, a.user.id);
      if (s.api_limits) forgetApiLimits(a.ctx.accountId);
      for (const k of Object.keys(s) as (keyof typeof s)[]) {
        before[k] = current[k];
        after[k] = next[k];
      }
    }
    const change = diff(before, after);
    if (Object.keys(change.after).length) await recordChange(tx, a, meta, change);
  });
  return reloaded(deps, a.ctx);
};

/** The logo lives on `accounts.logo_asset_id` (the file cleanup keeps what an account points at). */
const setLogo = (deps: Deps, a: Actor, assetId: string | null, meta: RequestMeta) =>
  deps.db.transaction(async (tx) => {
    const before = a.ctx.account.logoAssetId ?? null;
    if (before === assetId) return;
    await updateAccountRow(tx, a.ctx.accountId, { logoAssetId: assetId });
    await recordChange(tx, a, meta, { before: { logo_asset_id: before }, after: { logo_asset_id: assetId } });
  });

const reloaded = async (deps: Deps, ctx: AccountContext) =>
  getAccountDetail(deps, { ...ctx, account: (await findAccountById(deps.db, ctx.accountId))! });

/**
 * A PNG / JPEG logo declaring more pixels than any logo needs is refused (a small file can declare a huge image —
 * a decompression bomb for the public icon route, audit 2026-10-10 #6).
 */
const assertLogoPixels = async (deps: Deps, asset: { storageKey: string | null; mime: string }) => {
  if (!asset.storageKey || !/^image\/(png|jpeg)$/.test(asset.mime)) return;
  const bytes = await deps.storage.get(asset.storageKey, MAX_LOGO_BYTES + 1024);
  const pixels = bytes ? imagePixels(bytes) : null;
  if (pixels !== null && pixels > MAX_IMAGE_PIXELS) throw new AppError('payload_too_large', 'logo_too_large');
};

/** PUT /accounts/me/logo (admins): one of my finished uploads, an image ≤2 MB, becomes the account's logo. */
export const setAccountLogo = async (deps: Deps, a: Actor, fileId: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx);
  const [asset] = await ownUploadedAssets(deps.db, a, [fileId]);
  // Raster images only (S-14): an SVG can carry script and the logo is served in place.
  if (!isInlineSafeMime(asset!.mime) || !asset!.mime.startsWith('image/'))
    throw new AppError('invalid_value', 'logo_not_image');
  if (asset!.size > MAX_LOGO_BYTES) throw new AppError('payload_too_large', 'logo_too_large');
  await assertLogoPixels(deps, asset!);
  await setLogo(deps, a, asset!.id, meta);
  return reloaded(deps, a.ctx);
};

/** DELETE /accounts/me/logo (admins): back to the letter mark. */
export const removeAccountLogo = async (deps: Deps, a: Actor, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx);
  await setLogo(deps, a, null, meta);
  return reloaded(deps, a.ctx);
};

/** GET /accounts/me/logo — where the logo is (a signed URL), for <img> tags, which cannot send headers. */
export const accountLogoLocation = async (deps: Deps, ctx: AccountContext) => {
  const url = await accountLogoUrl(deps, ctx.accountId, ctx.account.logoAssetId);
  if (!url) throw new AppError('not_found', 'No logo');
  return url;
};

/** The email logo (ANSWERS 6א.3) lives in `settings.branding.email_logo_asset_id` (the file cleanup reads settings). */
const setEmailLogo = (deps: Deps, a: Actor, assetId: string | null, meta: RequestMeta) =>
  deps.db.transaction(async (tx) => {
    const current = await loadSettings(tx, a.ctx.accountId);
    const before = current.branding.email_logo_asset_id ?? null;
    if (before === assetId) return;
    const branding = { ...current.branding };
    if (assetId) branding.email_logo_asset_id = assetId;
    else delete branding.email_logo_asset_id;
    await upsertAccountSettings(tx, a.ctx.accountId, { ...current, branding }, a.user.id);
    await recordChange(tx, a, meta, {
      before: { email_logo_asset_id: before },
      after: { email_logo_asset_id: assetId },
    });
  });

/** PUT /accounts/me/email-logo (admins): a logo for emails only (else they show the account logo). */
export const setAccountEmailLogo = async (deps: Deps, a: Actor, fileId: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx);
  const [asset] = await ownUploadedAssets(deps.db, a, [fileId]);
  // Email clients show raster images only; an SVG is refused like for the account logo (S-14).
  if (!isInlineSafeMime(asset!.mime) || !asset!.mime.startsWith('image/'))
    throw new AppError('invalid_value', 'logo_not_image');
  if (asset!.size > MAX_LOGO_BYTES) throw new AppError('payload_too_large', 'logo_too_large');
  await assertLogoPixels(deps, asset!);
  await setEmailLogo(deps, a, asset!.id, meta);
  return reloaded(deps, a.ctx);
};

/** DELETE /accounts/me/email-logo (admins): emails go back to the account logo. */
export const removeAccountEmailLogo = async (deps: Deps, a: Actor, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx);
  await setEmailLogo(deps, a, null, meta);
  return reloaded(deps, a.ctx);
};

/**
 * GET /public/email-logo/{account} — public (emails cannot sign in): a redirect to a fresh signed URL of the
 * account's email logo, else its logo. Only a logo an admin chose for emails is ever served here.
 */
export const emailLogoLocation = async (deps: Deps, accountId: string) => {
  const account = isId(accountId) ? await findAccountById(deps.db, accountId) : undefined;
  if (!account || account.status === 'suspended' || (await accountClosed(deps.db, account.id)))
    throw new AppError('not_found', 'No logo');
  const settings = await loadSettings(deps.db, account.id);
  const url = await accountLogoUrl(deps, account.id, settings.branding.email_logo_asset_id ?? account.logoAssetId);
  if (!url) throw new AppError('not_found', 'No logo');
  return url;
};
