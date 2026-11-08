// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Cloudflare Turnstile, configured in layers: an account (Administration → Security) and the platform
 * (owner console → Platform settings) each hold their own keys and a master switch; every public place gets a mode —
 * `inherit` (follow the master switch, the default), `on` or `off`. A form has its own mode on top of the account's
 * "public forms" default. The honeypot field and the rate limits stay on always; Turnstile is the extra layer.
 */
export const CAPTCHA_MODES = ['inherit', 'on', 'off'] as const;
export type CaptchaMode = (typeof CAPTCHA_MODES)[number];
export const captchaModeSchema = z.enum(CAPTCHA_MODES);

/** The public places of an account (each a mode in the account's panel). */
export const ACCOUNT_CAPTCHA_SURFACES = ['forms'] as const;
export type AccountCaptchaSurface = (typeof ACCOUNT_CAPTCHA_SURFACES)[number];

/** The public places of the platform (sign-in screen and friends — no account yet). */
/** `registration`: the license server's public registration endpoint (licensing) — only where this is one. */
export const PLATFORM_CAPTCHA_SURFACES = ['sign_in', 'sign_up', 'forgot_password', 'registration'] as const;
export type PlatformCaptchaSurface = (typeof PLATFORM_CAPTCHA_SURFACES)[number];

/** The header the sign-in screen sends its Turnstile token in (Better Auth routes have their own bodies). */
export const CAPTCHA_TOKEN_HEADER = 'x-captcha-token';
/**
 * Set on a successful password reset while sign-in asks for Turnstile: a one-use, ~2 minute pass for the sign-in
 * with the new password right after (same user only). Sent back in this header on that sign-in.
 */
export const CAPTCHA_EXEMPT_HEADER = 'x-captcha-exempt';

const mode = () => captchaModeSchema.default('inherit');
const accountSurfacesSchema = z.object({ forms: mode() });
const platformSurfacesSchema = z.object({
  sign_in: mode(),
  sign_up: mode(),
  forgot_password: mode(),
  registration: mode(),
});

const base = {
  /** The master switch: places on `inherit` ask for the check when it is on (off by default). */
  enabled: z.boolean().default(false),
  /** The public site key (shown on pages); the secret is write-only and stored sealed. */
  site_key: z.string().trim().max(100).default(''),
};
export const accountCaptchaConfigSchema = z.object({
  ...base,
  surfaces: accountSurfacesSchema.default(accountSurfacesSchema.parse({})),
});
export const platformCaptchaConfigSchema = z.object({
  ...base,
  surfaces: platformSurfacesSchema.default(platformSurfacesSchema.parse({})),
});
export type AccountCaptchaConfig = z.infer<typeof accountCaptchaConfigSchema>;
export type PlatformCaptchaConfig = z.infer<typeof platformCaptchaConfigSchema>;

const dtoExtra = {
  /** A secret is saved (it is never sent back). */
  secret_set: z.boolean(),
  /** Both keys are there: only then can anything be switched on. */
  keys_ready: z.boolean(),
};
/** GET /security/captcha (account admin). */
export const accountCaptchaSchema = accountCaptchaConfigSchema.extend(dtoExtra).meta({ id: 'AccountCaptcha' });
export type AccountCaptcha = z.infer<typeof accountCaptchaSchema>;
/** GET /platform/captcha (platform owner). */
export const platformCaptchaSchema = platformCaptchaConfigSchema.extend(dtoExtra).meta({ id: 'PlatformCaptcha' });
export type PlatformCaptcha = z.infer<typeof platformCaptchaSchema>;

const updateBase = {
  enabled: z.boolean().optional(),
  site_key: z.string().trim().max(100).optional(),
  /** Write-only: a new secret, or null to remove it. */
  secret: z.string().trim().min(1).max(200).nullable().optional(),
};
export const updateAccountCaptchaSchema = z.object({
  ...updateBase,
  surfaces: z.object({ forms: captchaModeSchema.optional() }).optional(),
});
export const updatePlatformCaptchaSchema = z.object({
  ...updateBase,
  surfaces: z
    .object({
      sign_in: captchaModeSchema.optional(),
      sign_up: captchaModeSchema.optional(),
      forgot_password: captchaModeSchema.optional(),
      registration: captchaModeSchema.optional(),
    })
    .optional(),
});
export type UpdateAccountCaptcha = z.infer<typeof updateAccountCaptchaSchema>;
export type UpdatePlatformCaptcha = z.infer<typeof updatePlatformCaptchaSchema>;

/** Whether a place asks for the check: its own mode, else (`inherit`) the level above. */
export const captchaWanted = (mode: CaptchaMode, inherited: boolean) =>
  mode === 'on' ? true : mode === 'off' ? false : inherited;

/** What a form's editor needs to know of its account (Administration → Security → Turnstile). */
export const formAccountCaptchaSchema = z.object({
  /** The account has both keys. */
  keys_ready: z.boolean(),
  /** What `inherit` means for this form right now (the account's "public forms" mode + master switch). */
  inherited: z.boolean(),
});
export type FormAccountCaptcha = z.infer<typeof formAccountCaptchaSchema>;

/** GET /auth/config → `captcha`: the platform's site key and which sign-in screens ask for the check. */
export const authCaptchaSchema = z.object({
  site_key: z.string().nullable(),
  sign_in: z.boolean(),
  sign_up: z.boolean(),
  forgot_password: z.boolean(),
});
export type AuthCaptcha = z.infer<typeof authCaptchaSchema>;
