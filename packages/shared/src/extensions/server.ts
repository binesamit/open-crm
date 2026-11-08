// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { extensionManifestSchema } from './manifest';

/**
 * Extensions on their own server, versions and the platform catalog (D27 ת6–ת7, the planning notes "MARKETPLACE" §4.3,
 * §4.5, §4.6, §8).
 *
 * - An installation of a manifest with `server` gets an **extension service user** (like an agent's, D26) and
 *   OAuth client credentials. The extension's server trades them at the platform's OAuth token endpoint
 *   (`grant_type=client_credentials`, the MCP authorization server of מ5) for an hour-long access token that acts
 *   as that service user × the granted scopes × the granted boards × the extension path allowlist.
 * - **Lifecycle webhooks** go to the manifest's `server.lifecycle_url`, signed like every webhook here
 *   (`x-bines-signature: sha256=HMAC(signing_secret, "<timestamp>.<body>")`).
 * - A daily **update check** applies a version that asks for nothing new by itself; one that asks for more waits
 *   for an admin. A version can be locked, and an earlier approved version restored.
 */
export const EXT_CLIENT_ID_PREFIX = 'bos_extc_';
export const EXT_CLIENT_SECRET_PREFIX = 'bos_exts_';
export const EXT_SIGNING_SECRET_PREFIX = 'bos_extw_';
/** An extension server's access token (client_credentials). */
export const EXT_SERVER_TOKEN_PREFIX = 'bos_xat_';
export const isExtensionServerToken = (s: string) => s.startsWith(EXT_SERVER_TOKEN_PREFIX);
export const isExtensionClientId = (s: string | null | undefined) => !!s && s.startsWith(EXT_CLIENT_ID_PREFIX);
/** An extension server's access token lives an hour; it asks again with its client credentials. */
export const EXT_SERVER_TOKEN_TTL_S = 3600;

export const LIFECYCLE_EVENTS = ['installed', 'updated', 'enabled', 'disabled', 'uninstalled'] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

/** `1.2.3` vs `1.10.0` — numerically; a pre-release sorts before its release. 0 = same. */
export const compareSemver = (a: string, b: string): number => {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.split('+')[0]!.split(/-(.*)/s);
    return { nums: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
};

// ---- installations: server, versions ----

export const extensionServerInfoSchema = z.object({
  lifecycle_url: z.string(),
  /** connected = the last lifecycle call was answered 2xx; failed = it was not (the admin can send it again). */
  status: z.enum(['pending', 'connected', 'failed']),
  client_id: z.string().nullable(),
  last_error: z.string().nullable(),
  last_event: z.string().nullable(),
  last_event_at: z.string().nullable(),
});
export type ExtensionServerInfo = z.infer<typeof extensionServerInfoSchema>;

export const extensionVersioningSchema = z.object({
  /** Stay on this version: the daily check only reports newer ones. */
  version_locked: z.boolean().optional(),
  /** Off = even a version asking for nothing new waits for the admin. */
  auto_update: z.boolean().optional(),
});

export const extensionVersionSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    /** auto = the daily check; approved = an admin consented; installed; rollback. */
    via: z.enum(['installed', 'auto', 'approved', 'manual', 'rollback']),
    applied_by_name: z.string().nullable(),
    created_at: z.string(),
    current: z.boolean(),
    scopes: z.array(z.string()),
  })
  .meta({ id: 'ExtensionVersion' });
export type ExtensionVersion = z.infer<typeof extensionVersionSchema>;

export const rollbackExtensionSchema = z.object({ version_id: z.string().max(26) });

export const updateCheckResultSchema = z.enum(['current', 'updated', 'pending', 'locked', 'failed']);
export type UpdateCheckResult = z.infer<typeof updateCheckResultSchema>;

// ---- the platform catalog (ת7) ----

/** MARKETPLACE §8 — what the platform owner checks before an extension joins the catalog of every account. */
export const REVIEW_CHECKS = [
  'https_only',
  'least_scopes',
  'no_token_storage',
  'verifies_signatures',
  'no_eval',
  'privacy_policy',
  'platform_limits',
] as const;
export type ReviewCheck = (typeof REVIEW_CHECKS)[number];

export const catalogReviewSchema = z.object({
  checks: z.partialRecord(z.enum(REVIEW_CHECKS), z.boolean()).default({}),
  notes: z.string().trim().max(4000).default(''),
  // EXT-RT14: a link people may click — http(s) only (`z.url()` alone takes `javascript:` too).
  privacy_url: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .optional(),
});
export type CatalogReview = z.infer<typeof catalogReviewSchema>;

/** A code extension enters the catalog only with every check ticked; a data pack runs no code. */
export const reviewComplete = (review: Pick<CatalogReview, 'checks'>) => REVIEW_CHECKS.every((k) => review.checks[k]);

export const catalogSourceSchema = z.union([
  z.object({ manifest_url: z.url().max(2000) }),
  z.object({ manifest: z.record(z.string(), z.unknown()) }),
]);
export type CatalogSource = z.infer<typeof catalogSourceSchema>;

export const publishCatalogSchema = z.object({ source: catalogSourceSchema, review: catalogReviewSchema });

export const catalogPreviewSchema = z
  .object({
    manifest: extensionManifestSchema,
    kind: z.enum(['data', 'code']),
    warnings: z.array(z.string()),
    /** The catalog entry it would replace. */
    existing: z.object({ version: z.string() }).nullable(),
    review_required: z.boolean(),
  })
  .meta({ id: 'CatalogPreview' });

export const catalogEntryInfoSchema = z.object({
  version: z.string(),
  source_url: z.string().nullable(),
  review: z
    .object({
      checks: z.record(z.string(), z.boolean()),
      notes: z.string(),
      privacy_url: z.string().nullable(),
      reviewed_by_name: z.string().nullable(),
      reviewed_at: z.string(),
    })
    .nullable(),
  published_at: z.string().nullable(),
});
export type CatalogEntryInfo = z.infer<typeof catalogEntryInfoSchema>;
