// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { brandColorSchema } from '../platform/settings';

/**
 * The phone app (PWA, the planning notes "PWA"): the account's home-screen app (name, colour, first screen), the install
 * suggestion, Web Push and what a locked screen shows. Everything is a setting — nothing per client in code.
 */

/** The screen the installed app opens on. */
export const PWA_START_PAGES = ['my_work', 'home', 'inbox'] as const;
export type PwaStartPage = (typeof PWA_START_PAGES)[number];

/** What a push shows on a locked screen: the whole sentence, or only "you have a new notification". */
export const PWA_LOCK_SCREEN = ['full', 'generic'] as const;
export type PwaLockScreen = (typeof PWA_LOCK_SCREEN)[number];

/** `account_settings.settings.pwa` (admins). */
export const accountPwaSettingsSchema = z.object({
  /** The name under the home-screen icon (empty = the account's name). */
  app_name: z.string().trim().min(1).max(30).optional(),
  /** Splash screen / status bar colour (empty = the platform's, then the built-in colour). */
  theme_color: brandColorSchema.optional(),
  start_page: z.enum(PWA_START_PAGES).default('my_work'),
  /** Offer "add to home screen" on phones (a gentle bar after a few visits). */
  install_prompt: z.boolean().default(true),
  /** After how many visits from a phone the bar appears. */
  install_prompt_after: z.number().int().min(1).max(30).default(3),
  /** Push notifications in this account at all. */
  push_enabled: z.boolean().default(true),
  lock_screen: z.enum(PWA_LOCK_SCREEN).default('full'),
});
export type AccountPwaSettings = z.infer<typeof accountPwaSettingsSchema>;

/** PATCH /accounts/me → settings.pwa: only what is sent changes; null = back to the default. */
export const updateAccountPwaSchema = z.object({
  app_name: z.string().trim().min(1).max(30).nullable().optional(),
  theme_color: brandColorSchema.nullable().optional(),
  start_page: z.enum(PWA_START_PAGES).optional(),
  install_prompt: z.boolean().optional(),
  install_prompt_after: z.number().int().min(1).max(30).optional(),
  push_enabled: z.boolean().optional(),
  lock_screen: z.enum(PWA_LOCK_SCREEN).optional(),
});

/**
 * Icon files of the manifest: purpose `any` 192 / 512, `maskable` 512 (Android), 180 (iOS apple-touch-icon), and
 * the browser tab's icon (favicon, 32) — the same drawing as the home-screen icon.
 */
export const PWA_ICONS = ['192', '512', 'maskable-512', 'apple-180', 'favicon-32'] as const;
export type PwaIcon = (typeof PWA_ICONS)[number];
export const pwaIconSize = (icon: PwaIcon) => Number(icon.split('-').pop());

/**
 * The `type` of the user's push row that keeps "unread count on the app icon" (enabled = on). Not a category, so
 * `channelAllowed` never reads it.
 */
export const PUSH_BADGE_ROW = 'badge';

/** Quiet hours of push: from (inclusive) → to (exclusive), local hours; from > to wraps midnight (22 → 7). */
export type QuietHours = { enabled: boolean; from: number; to: number };
export const DEFAULT_QUIET: QuietHours = { enabled: false, from: 22, to: 7 };

/** The `digest` column of the user's account-wide push row: `instant` (no quiet hours) or `quiet:<from>:<to>`. */
export const parseQuiet = (s: string | null | undefined): QuietHours => {
  const [k, a, b] = (s ?? '').split(':');
  const hour = (v: string | undefined) => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
  };
  const from = hour(a);
  const to = hour(b);
  if (k !== 'quiet' || from === null || to === null) return DEFAULT_QUIET;
  return { enabled: true, from, to };
};
export const formatQuiet = (q: QuietHours) => (q.enabled ? `quiet:${q.from}:${q.to}` : 'instant');

/** Is `hour` (0–23, the user's local time) inside the quiet hours? Equal from / to = never quiet. */
export const inQuietHours = (q: QuietHours, hour: number) => {
  if (!q.enabled || q.from === q.to) return false;
  return q.from < q.to ? hour >= q.from && hour < q.to : hour >= q.from || hour < q.to;
};

/** platform_settings row id that keeps the generated VAPID pair (never returned by GET /platform/settings). */
export const VAPID_ROW_ID = 'vapid';

/**
 * The push sender's contact (RFC 8292 `sub`): VAPID_SUBJECT when it is a mailto: / https: address, else the web
 * origin when it is https, else a mailto of its host (local development).
 */
export const vapidSubject = (subject: string | undefined, webOrigin: string) => {
  if (subject && /^(mailto:|https:\/\/)/.test(subject)) return subject;
  try {
    const u = new URL(webOrigin);
    return u.protocol === 'https:' ? u.origin : `mailto:push@${u.hostname.includes('.') ? u.hostname : 'example.com'}`;
  } catch {
    return 'mailto:push@example.com';
  }
};

// ---- API shapes ----

/**
 * The push services browsers subscribe with (FCM — Chrome, Edge on Android, Samsung, Opera, Brave; Mozilla;
 * Windows WNS — Edge; Apple). An endpoint elsewhere is refused at subscribe and never called by the worker — the
 * server only ever sends to these hosts (audit 2026-10-10 #4: no request to internal addresses, whatever DNS says).
 */
export const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
] as const;

/** Whether a push endpoint is an https URL on one of the known push services (the host or a subdomain). */
export const isPushServiceEndpoint = (endpoint: string) => {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
    );
  } catch {
    return false;
  }
};

export const pushSubscriptionInputSchema = z
  .object({
    endpoint: z
      .url({ protocol: /^https$/ })
      .max(2048)
      .refine(isPushServiceEndpoint, { message: 'push_endpoint_unknown' }),
    keys: z.object({ p256dh: z.string().min(16).max(256), auth: z.string().min(8).max(128) }),
    /** A short name the settings list shows ("iPhone", "Chrome on Android"); the server guesses one when absent. */
    device_label: z.string().trim().max(80).optional(),
  })
  .meta({ id: 'PushSubscriptionInput' });
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;

export const pushSubscriptionSchema = z
  .object({
    id: z.string(),
    device_label: z.string(),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
    /** This browser's subscription (the request sent its endpoint). */
    current: z.boolean(),
  })
  .meta({ id: 'PushSubscription' });
export type PushSubscriptionRow = z.infer<typeof pushSubscriptionSchema>;

export const pushSubscriptionListSchema = z
  .object({ data: z.array(pushSubscriptionSchema) })
  .meta({ id: 'PushSubscriptionList' });

export const pushEndpointSchema = z.object({ endpoint: z.string().min(1).max(2048) }).meta({ id: 'PushEndpoint' });

/** GET /pwa/config: what the app needs inside an account. */
export const pwaConfigSchema = z
  .object({
    /** Push may be offered here (platform and account switches, and server keys exist). */
    push_enabled: z.boolean(),
    /** The VAPID public key (base64url) for PushManager.subscribe; null = push unavailable. */
    vapid_public_key: z.string().nullable(),
    install_prompt: z.boolean(),
    install_prompt_after: z.number().int(),
    manifest_url: z.string(),
    apple_icon_url: z.string(),
    /** The browser tab's icon (32×32 PNG): the home-screen icon drawn small. */
    favicon_url: z.string(),
    theme_color: z.string(),
    app_name: z.string(),
  })
  .meta({ id: 'PwaConfig' });
export type PwaConfig = z.infer<typeof pwaConfigSchema>;

/**
 * "Must refresh to continue" (PWA): bump this number in the commit whose server would break pages still open from
 * an older build (a removed / changed endpoint they call, a new required field…). Every page built with a smaller
 * number then gets a screen with only "refresh" (never an automatic reload); any other new build only shows the
 * "a new version — refresh" bar. The page compiles its own value in; GET /public/pwa/status returns the server's.
 * Kept in code (not an environment variable) so it travels with the change that needs it and stays ordered.
 */
export const PWA_BREAKING_EPOCH = 0;

/** GET /public/pwa/status: the service worker's kill switch, the server's build and its breaking epoch. */
export const pwaStatusSchema = z
  .object({
    sw_enabled: z.boolean(),
    /** The build of the web app the server serves ('dev' = unknown: no comparison). */
    build: z.string(),
    /** PWA_BREAKING_EPOCH of the server: a page built with a smaller one must refresh. */
    breaking_epoch: z.number().int(),
  })
  .meta({ id: 'PwaStatus' });
export type PwaStatus = z.infer<typeof pwaStatusSchema>;

/** What a push message carries (encrypted on the way; the service worker shows it). */
export type PushPayload = {
  title: string;
  body: string;
  /** Opens here on click (same origin). */
  url: string;
  /** The notification's id — one notification per tag (a newer one replaces it); a click marks it read. */
  tag: string;
  /** The notification's account (the mark-read request on click is scoped to it). */
  account_id: string;
  /** The bell's unread count in that account (the app icon's badge); null = leave it. */
  badge: number | null;
  icon?: string;
};
