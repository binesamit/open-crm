// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    API_PORT: z.coerce.number().int().positive().default(3000),
    /** Public origin of the web app; links in emails point here. In production the API serves the SPA on the same origin. */
    WEB_ORIGIN: z.url().default('http://localhost:5173'),
    DATABASE_URL: optionalString,
    /**
     * Standalone mode (src/standalone.ts, the image's default command): the folder holding everything the
     * installation keeps — the embedded database when DATABASE_URL is unset (`db/`), uploaded files when no S3 is
     * configured (`files/`) and the secrets generated on first boot (`secrets.json`). Set = standalone.
     */
    DATA_DIR: optionalString,
    /** Files on the local disk when no S3 is configured (standalone mode: `$DATA_DIR/files`). Served by the API. */
    FILES_DIR: optionalString,
    /**
     * Set by standalone mode when WEB_ORIGIN was not given: the first-run setup saves the address the owner opened
     * as the public address (owner console → Platform settings), so links and file URLs use it.
     */
    AUTO_PUBLIC_ADDRESS: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),

    BETTER_AUTH_SECRET: optionalString,
    /** Origin Better Auth runs on (same as WEB_ORIGIN unless split). */
    BETTER_AUTH_URL: optionalString,
    /** AES-256-GCM key for secrets at rest (AI connection keys): 32 bytes, base64 or hex. Unset = derived from BETTER_AUTH_SECRET. */
    SECRETS_KEY: optionalString,
    /**
     * Master key of secret columns: wraps each account's data key (envelope encryption). 32 bytes
     * base64 or 64 hex characters (`openssl rand -base64 32`). Required for secret columns in production (a clear
     * 503 `secret_master_key_missing` otherwise); outside production a fixed development key is used. Never logged.
     * Losing it loses every secret value.
     */
    SECRET_MASTER_KEY: optionalString,
    /**
     * Web Push (PWA) VAPID keys, base64url (public = 65-byte P-256 point, private = 32 bytes). Optional: unset, the
     * server creates a pair once and keeps it in platform_settings (row `vapid`). Set both to pin your own pair.
     */
    VAPID_PUBLIC_KEY: optionalString,
    VAPID_PRIVATE_KEY: optionalString,
    /** Contact of the push sender (mailto: or https:); unset = WEB_ORIGIN when https, else a mailto of its host. */
    VAPID_SUBJECT: optionalString,
    /**
     * Sign-in providers: the fallback when the owner console (ספקי התחברות) has no credentials saved
     * for the provider. MICROSOFT_TENANT_ID: `common` (default), `organizations`, `consumers` or a directory id.
     */
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    MICROSOFT_CLIENT_ID: optionalString,
    MICROSOFT_CLIENT_SECRET: optionalString,
    MICROSOFT_TENANT_ID: optionalString,

    /** Becomes platform owner on first sign-in (D12); invited as admin of the first account (db/bootstrap.ts). */
    SEED_ADMIN_EMAIL: z.string().toLowerCase().optional(),

    RESEND_API_KEY: optionalString,
    /**
     * Incoming email: the signing secret of the provider's `email.received` webhook (`whsec_…`).
     * Unset = the inbound endpoint refuses every call (never an unsigned one). The message itself is fetched with
     * RESEND_INBOUND_API_KEY, else RESEND_API_KEY (a key with receiving access).
     */
    RESEND_INBOUND_SECRET: optionalString,
    RESEND_INBOUND_API_KEY: optionalString,
    /** The receiving API's address (default Resend's): a compatible provider, or the E2E stand-in. */
    RESEND_API_BASE: optionalString,
    /** RESEND_FROM (bare address) is accepted as an alias. */
    EMAIL_FROM: optionalString,
    RESEND_FROM: optionalString,
    /**
     * Force the mail transport (`resend` | `smtp` | `mailpit` | `none`). Unset = the first configured one:
     * RESEND_API_KEY, then SMTP_HOST, then MAILPIT_URL; none = email off (logged at startup, never a crash).
     */
    EMAIL_TRANSPORT: optionalString,
    /** Plain SMTP (self-hosting, any server). SMTP_HOST set = the SMTP transport (unless Resend is configured). */
    SMTP_HOST: optionalString,
    /** Default 587 (STARTTLS), or 465 when SMTP_SECURE=true. */
    SMTP_PORT: optionalString,
    SMTP_USER: optionalString,
    SMTP_PASS: optionalString,
    /** `true` = TLS from the first byte (port 465). Default: true only on port 465. */
    SMTP_SECURE: optionalString,
    /** S-75: STARTTLS is required unless the host is this machine; `false` = allow cleartext (trusted relay only). */
    SMTP_REQUIRE_TLS: optionalString,
    /** TextMe SMS (my.textme.co.il). */
    TEXTME_API_KEY: optionalString,
    TEXTME_USERNAME: optionalString,
    /** The fallback SMS sender id; the owner console (platform) and each account (Administration) choose their own. */
    TEXTME_SENDER_ID: optionalString,
    /** Files: S3-compatible — Cloudflare R2 in production (https://<account>.r2.cloudflarestorage.com), MinIO locally. */
    S3_ENDPOINT: optionalString,
    /**
     * The storage address browsers use (presigned uploads / downloads, CSP), when it differs from S3_ENDPOINT — e.g.
     * self-hosted MinIO: S3_ENDPOINT=http://minio:9000 (server side), S3_PUBLIC_ENDPOINT=https://files.example.com.
     * Unset = S3_ENDPOINT for both.
     */
    S3_PUBLIC_ENDPOINT: optionalString,
    S3_BUCKET: optionalString,
    S3_REGION: z.string().default('auto'),
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /** Set bucket CORS on startup. R2 object keys cannot; there CORS is managed with `wrangler r2 bucket cors set`. */
    S3_SET_CORS: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /** Local dev: Mailpit HTTP API (docker-compose); used when RESEND_API_KEY is absent. */
    MAILPIT_URL: optionalString,
    /** Staging: only these recipients get email (comma list of addresses or @domains); others are logged and skipped. */
    MAIL_ALLOWLIST: optionalString,
    /** Error monitoring (GlitchTip, Sentry protocol): the api project's DSN. Unset = monitoring off. */
    SENTRY_DSN: optionalString,
    /** Overrides the reported environment (default: RAILWAY_ENVIRONMENT_NAME, else NODE_ENV). */
    SENTRY_ENVIRONMENT: optionalString,
    /** The web project's DSN, baked into the SPA at build time; its origin is added to the CSP connect-src. */
    VITE_SENTRY_DSN: optionalString,
    /** Set by Railway: the release (commit) and environment name reported with errors. */
    RAILWAY_GIT_COMMIT_SHA: optionalString,
    RAILWAY_ENVIRONMENT_NAME: optionalString,

    /**
     * Where the real client address comes from (S-10, lib/client-ip.ts): `edge` (default — Railway's edge rewrites
     * X-Forwarded-For, the first entry is the client), a number of trusted proxies that append to it, or `none`.
     */
    TRUST_PROXY: z
      .string()
      .optional()
      .refine((v) => !v || /^(edge|none|true|false|\d{1,2})$/i.test(v.trim()), 'edge | none | <hop count>'),
    /** The header the trusted proxy sets (default x-forwarded-for; e.g. x-real-ip, cf-connecting-ip). */
    CLIENT_IP_HEADER: optionalString,
    /** Requests per client address per 10 seconds, every /api route (06 §1.10). 0 = off. */
    RATE_LIMIT_IP_PER_10S: z.coerce.number().int().min(0).default(5000),
    /** API-token requests per account per minute, all its tokens together (06 §1.10). 0 = off. */
    RATE_LIMIT_ACCOUNT_PER_MIN: z.coerce.number().int().min(0).default(3000),
    /** Invitation emails one person may send per hour, all accounts together (S-12). 0 = off. */
    INVITE_EMAILS_PER_HOUR: z.coerce.number().int().min(0).default(50),
    /** MCP authorization server (מ5), per client address: authorize / token / revoke calls a minute. 0 = off. */
    OAUTH_RATE_PER_MIN: z.coerce.number().int().min(0).default(60),
    /** MCP authorization server: dynamic client registrations per client address an hour. 0 = off. */
    OAUTH_REGISTER_PER_HOUR: z.coerce.number().int().min(0).default(20),
    /**
     * Maps (M8 ד10, D25): the default map style (vector tiles) for accounts that did not choose their own in
     * Administration → Connections. OpenFreeMap: free, no key, no view limit (the OSM tile servers are not for apps).
     */
    MAP_STYLE_URL: z.url().default('https://tiles.openfreemap.org/styles/liberty'),
    /** Extra origins the map may load from (style, tiles, glyphs, sprites), comma-separated — joins the CSP. */
    MAP_ORIGINS: optionalString,
    /** Address → coordinates without an account key: a Nominatim server (1 request a second, its usage policy). */
    GEOCODER_URL: z.url().default('https://nominatim.openstreetmap.org'),
    /** Contact address sent to Nominatim (its policy asks apps to identify themselves). */
    GEOCODER_EMAIL: optionalString,
    /** Minimum gap between two geocoder requests of this process, in ms (Nominatim: at most 1 a second). */
    GEOCODER_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(1100),
    /** Google Places API base (address completion and geocoding with an account key); tests point it at a fake. */
    GOOGLE_PLACES_URL: z.url().default('https://places.googleapis.com'),
    /**
     * Fix: — address completion without an account key: a Photon server (komoot, OpenStreetMap data).
     * The public one by default; a self-hosted Photon for heavy use. Called from the server only, throttled.
     */
    PHOTON_URL: z.url().default('https://photon.komoot.io'),
    /** Minimum gap between two Photon requests of this process, in ms (be polite to the public server). */
    PHOTON_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(250),
    GOOGLE_GEOCODE_URL: z.url().default('https://maps.googleapis.com'),
    /**
     * Test-only (E2E): `scripted` answers every AI call with the scripted stand-in of @bines/server-ai (no key, no
     * spend; agents follow `TOOL <name> <json>` lines of their prompt). Refused in production.
     */
    AI_FAKE: z.enum(['scripted']).optional(),
    /**
     * Outgoing calls (webhooks, automation / extension calls, manifests, flows, MCP servers) may reach private and
     * loopback addresses — local development only, an explicit `1` (audit 2026-10-10 #7: never implied by a missing
     * NODE_ENV). Tests allow them by themselves. Refused in production.
     */
    OUTBOUND_ALLOW_PRIVATE: z
      .enum(['1'])
      .optional()
      .or(z.literal('').transform(() => undefined)),
    /**
     * Licensing (docs/LICENSING.md): the license server this installation registers with and checks its key against
     * — the owner console's setting wins; unset (and no setting) = registration unavailable. No address is built in.
     */
    LICENSE_SERVER_URL: z
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    /**
     * The licensor's Ed25519 signing key (PKCS#8 PEM — real newlines or `\n` — or its base64): makes THIS
     * installation a license server (public registration, Installations and Licenses screens). A secret: whoever
     * holds it can issue keys. Never logged.
     */
    LICENSE_SIGNING_KEY: optionalString,
    /** `false` = the telemetry heartbeat is never sent, whatever the owner console says (it is off by default). */
    BINES_TELEMETRY: optionalString,
    /** `false` = no online check of the license key (renewal / revocation) and no update check. */
    BINES_UPDATE_CHECK: optionalString,
    /**
     * White-label of the public API reference (/api/docs): the product name (default: the app's English name,
     * `app.name` in i18n), a logo URL (also the page icon) and the brand colour (#rrggbb; default the F4 shell).
     */
    PRODUCT_NAME: optionalString,
    API_DOCS_LOGO_URL: optionalString,
    API_DOCS_BRAND_COLOR: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, '#rrggbb')
      .optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // Standalone mode (DATA_DIR) brings its own database (embedded) and owner (first-run setup in the browser).
    const required = env.DATA_DIR ? (['BETTER_AUTH_SECRET'] as const) : DEPLOY_REQUIRED;
    for (const key of required) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required in production' });
    }
    if (env.AI_FAKE) ctx.addIssue({ code: 'custom', path: ['AI_FAKE'], message: 'test-only, not in production' });
    if (env.OUTBOUND_ALLOW_PRIVATE)
      ctx.addIssue({
        code: 'custom',
        path: ['OUTBOUND_ALLOW_PRIVATE'],
        message: 'development only, not in production',
      });
    // another receiving API must be a real HTTPS service — the E2E stand-in (local http) never runs here.
    if (env.RESEND_API_BASE && !/^https:\/\/(?!localhost\b|127\.|\[::1\])[^/]+/i.test(env.RESEND_API_BASE))
      ctx.addIssue({ code: 'custom', path: ['RESEND_API_BASE'], message: 'an https address of a mail provider' });
    if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length < 32) {
      ctx.addIssue({ code: 'custom', path: ['BETTER_AUTH_SECRET'], message: 'at least 32 characters' });
    }
    // S-74: a value copied from .env.example / a doc, or the development fallback, is public — it signs sessions,
    // extension and collab tokens and derives the at-rest keys. A self-hosted install must not start with it.
    for (const key of ['BETTER_AUTH_SECRET', 'SECRETS_KEY', 'SECRET_MASTER_KEY'] as const) {
      const v = env[key];
      if (v && isPlaceholderSecret(v))
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'looks like a placeholder — generate one with `openssl rand -base64 32`',
        });
    }
  });

const DEPLOY_REQUIRED = ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'SEED_ADMIN_EMAIL'] as const;

/** Words of example / development secrets, and too few distinct characters (`xxxxxxxx…`, `aaaa…`). */
const PLACEHOLDER_SECRET = /change-?me|dev-only|not-for-production|placeholder|your[-_ ]?secret|example|xxxxxxxx/i;
export const isPlaceholderSecret = (v: string) => PLACEHOLDER_SECRET.test(v) || new Set(v).size < 8;

export type Env = z.infer<typeof envSchema>;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  // Railway (and most PaaS) inject PORT; API_PORT wins when both are set.
  const parsed = envSchema.safeParse({ API_PORT: source.PORT, ...source });
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};
