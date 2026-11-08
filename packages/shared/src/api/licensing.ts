// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { LICENSE_PLANS, SUPPORT_LEVELS } from './editions';
import { featureKeySchema } from './plans';

/**
 * Registration, telemetry and the license server (docs/LICENSING.md, part C of the approved model).
 *
 * Self-hosted side: after the first admin exists the platform owner sees one optional questionnaire ("skip" is
 * always there). Submitting sends ONLY the answers + this installation's random `instance_id` + the version to the
 * configured license server (owner console setting, else env `LICENSE_SERVER_URL`; empty = registration
 * unavailable — no address is built into the code). The server emails a verification link; once verified it issues a
 * Registered key bound to the `instance_id`, which this installation picks up and installs by itself.
 *
 * License-server side: active only where the signing private key is configured (`LICENSE_SIGNING_KEY`). It keeps
 * the installations and the licenses it issued (owner console → Licensing).
 *
 * Telemetry: off by default. With the owner's opt-in, a daily heartbeat (version, active users, boards count) — and
 * nothing else. `BINES_TELEMETRY=false` forces it off; `BINES_UPDATE_CHECK=false` turns the online check off.
 */

export const REGISTRATION_SIZES = ['1-5', '6-20', '21-100', '100+'] as const;
export type RegistrationSize = (typeof REGISTRATION_SIZES)[number];
export const REGISTRATION_USE_CASES = ['crm', 'tasks', 'service', 'other'] as const;
export type RegistrationUseCase = (typeof REGISTRATION_USE_CASES)[number];

/** An installation id: random, made once per installation (letters, digits, `-`). */
export const instanceIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'instance_id_invalid');

/** The questionnaire (every answer but the email is optional; the marketing box is never pre-ticked). */
export const registrationAnswersSchema = z.object({
  company: z.string().trim().max(200).optional().default(''),
  size: z.enum(REGISTRATION_SIZES).nullable().optional().default(null),
  role: z.string().trim().max(120).optional().default(''),
  use_case: z.enum(REGISTRATION_USE_CASES).nullable().optional().default(null),
  email: z.email().max(320),
  marketing_opt_in: z.boolean().optional().default(false),
});
export type RegistrationAnswers = z.infer<typeof registrationAnswersSchema>;

/** POST /platform/registration (the owner, on the installation). */
export const submitRegistrationSchema = registrationAnswersSchema.extend({
  /** The license server's Turnstile token, when it asks for one. */
  captcha_token: z.string().max(4096).optional(),
  locale: z.enum(['he', 'en']).optional(),
});
export type SubmitRegistration = z.infer<typeof submitRegistrationSchema>;

export const REGISTRATION_STATUSES = ['unasked', 'skipped', 'pending', 'registered'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** The heartbeat body (and the telemetry preview): version, active users, boards — nothing else. */
export const heartbeatSchema = z
  .object({
    instance_id: instanceIdSchema,
    version: z.string().max(40),
    active_users: z.number().int().min(0),
    boards: z.number().int().min(0),
    /** The registration's secret: a registered installation's telemetry is taken only with it (audit 2026-10-10 #22). */
    poll_secret: z.string().max(100).optional(),
  })
  .meta({ id: 'Heartbeat' });
export type Heartbeat = z.infer<typeof heartbeatSchema>;

/** GET /platform/licensing — the installation's licensing settings (platform owner). */
export const licensingSettingsSchema = z
  .object({
    instance_id: z.string(),
    /** The license server in use ('' = none: registration unavailable). */
    server_url: z.string(),
    /** Where it came from: the console setting, the env `LICENSE_SERVER_URL`, or nowhere. */
    server_url_source: z.enum(['setting', 'env', 'none']),
    /** The console setting itself (null = not set). */
    server_url_setting: z.string().nullable(),
    /** The license server's public key (PEM): keys it issues are trusted here. Fetched from the server, or pasted. */
    server_public_key: z.string().nullable(),
    server_key_fingerprint: z.string().nullable(),
    registration: z.object({
      status: z.enum(REGISTRATION_STATUSES),
      email: z.string().nullable(),
      at: z.string().nullable(),
      /** Show the first-run questionnaire now (unasked, and a license server is configured). */
      ask: z.boolean(),
    }),
    /** Register from another browser (offline installs): the license server's page for this installation. */
    offline_register_url: z.string().nullable(),
    telemetry: z.object({
      /** The owner's opt-in (off by default). */
      enabled: z.boolean(),
      /** `BINES_TELEMETRY=false`: never sent, whatever the setting. */
      forced_off: z.boolean(),
      last_sent_at: z.string().nullable(),
      /** Exactly what a heartbeat sends now. */
      preview: heartbeatSchema,
    }),
    /** `BINES_UPDATE_CHECK=false`: no online check of the key (or of updates). */
    update_check_forced_off: z.boolean(),
  })
  .meta({ id: 'LicensingSettings' });
export type LicensingSettings = z.infer<typeof licensingSettingsSchema>;

export const updateLicensingSettingsSchema = z.object({
  /** The license server's address (https://…, or http:// for a local one); null = back to the env / none. */
  server_url: z.url().max(300).nullable().optional(),
  /** The server's public key (PEM), pasted by hand when it cannot be fetched; null = forget it. */
  server_public_key: z.string().trim().max(400).nullable().optional(),
  telemetry: z.boolean().optional(),
});

/** GET /public/licenses/key: the license server's public key, for the installations it serves. */
export const publicLicenseKeySchema = z
  .object({ public_key: z.string(), fingerprint: z.string() })
  .meta({ id: 'PublicLicenseKey' });
export type PublicLicenseKey = z.infer<typeof publicLicenseKeySchema>;
export type UpdateLicensingSettings = z.infer<typeof updateLicensingSettingsSchema>;

/** What the license server says about registering (proxied for the questionnaire). */
export const registrationFormSchema = z
  .object({
    available: z.boolean(),
    /** The license server's Turnstile site key, when it asks for the check. */
    captcha_site_key: z.string().nullable(),
    /** The license server sells licenses online (its payment provider is set up): show "Buy a license". */
    purchase_available: z.boolean().optional(),
  })
  .meta({ id: 'RegistrationForm' });
export type RegistrationForm = z.infer<typeof registrationFormSchema>;

// ---------------------------------------------------------------- the license server's public endpoints

/** POST /public/installations/register (the license server). */
export const publicRegisterSchema = registrationAnswersSchema.extend({
  instance_id: instanceIdSchema,
  version: z.string().trim().max(40).optional(),
  locale: z.enum(['he', 'en']).optional(),
  /** Registering again (new details) for an already verified installation needs its registration secret. */
  poll_secret: z.string().max(100).optional(),
});
export type PublicRegister = z.infer<typeof publicRegisterSchema>;

export const publicRegisterResultSchema = z
  .object({
    status: z.literal('pending_verification'),
    /** With `poll_secret`: lets the installation ask for its key once the email is verified. */
    registration_id: z.string(),
    poll_secret: z.string(),
  })
  .meta({ id: 'PublicRegisterResult' });
export type PublicRegisterResult = z.infer<typeof publicRegisterResultSchema>;

export const publicPollSchema = z.object({ registration_id: z.string().max(40), poll_secret: z.string().max(100) });
export const publicPollResultSchema = z
  .object({ status: z.enum(['pending', 'verified']), key: z.string().nullable() })
  .meta({ id: 'PublicPollResult' });
export type PublicPollResult = z.infer<typeof publicPollResultSchema>;

export const publicVerifySchema = z.object({ token: z.string().min(10).max(200) });
export const publicVerifyResultSchema = z
  .object({ key: z.string(), licensee: z.string(), instance_id: z.string() })
  .meta({ id: 'PublicVerifyResult' });
export type PublicVerifyResult = z.infer<typeof publicVerifyResultSchema>;

/** POST /public/licenses/check: is this key still good, and is there a newer one for this installation? */
export const publicLicenseCheckSchema = z.object({
  instance_id: instanceIdSchema,
  license_id: z.string().max(64).nullable().optional(),
  /** A registered installation proves it is the one asking; without it the answer is `unknown`, never a key. */
  poll_secret: z.string().max(100).optional(),
});
export const publicLicenseCheckResultSchema = z
  .object({
    status: z.enum(['active', 'revoked', 'unknown']),
    /** A newer key for this license (a renewal), when there is one. */
    key: z.string().nullable(),
  })
  .meta({ id: 'PublicLicenseCheckResult' });
export type PublicLicenseCheckResult = z.infer<typeof publicLicenseCheckResultSchema>;

// ---------------------------------------------------------------- the license server's owner screens

/** GET /platform/license-server: is this installation a license server? */
export const licenseServerStatusSchema = z
  .object({
    enabled: z.boolean(),
    /** Where the signing key comes from: the owner console (`setting`), the env `LICENSE_SIGNING_KEY`, or nowhere. */
    source: z.enum(['setting', 'env', 'none']),
    /** The public half (PEM) — what installations served by this server store as their provider's key. */
    public_key: z.string().nullable(),
    /** A short name of the public key, to compare on both sides. */
    fingerprint: z.string().nullable(),
  })
  .meta({ id: 'LicenseServerStatus' });
export type LicenseServerStatus = z.infer<typeof licenseServerStatusSchema>;

export const installationSchema = z
  .object({
    id: z.string(),
    instance_id: z.string(),
    company: z.string(),
    size: z.string().nullable(),
    role: z.string(),
    use_case: z.string().nullable(),
    email: z.string(),
    email_verified: z.boolean(),
    marketing_opt_in: z.boolean(),
    version: z.string().nullable(),
    registered_at: z.string(),
    verified_at: z.string().nullable(),
    last_seen_at: z.string().nullable(),
    active_users: z.number().int().nullable(),
    boards: z.number().int().nullable(),
    license_id: z.string().nullable(),
    /** It holds a registration secret: it registers again (and its heartbeat counts) only with it. */
    secret_set: z.boolean(),
  })
  .meta({ id: 'Installation' });
export type Installation = z.infer<typeof installationSchema>;

export const installationsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  size: z.enum(REGISTRATION_SIZES).optional(),
  use_case: z.enum(REGISTRATION_USE_CASES).optional(),
  verified: z.enum(['yes', 'no']).optional(),
  marketing: z.enum(['yes', 'no']).optional(),
});
export type InstallationsQuery = z.infer<typeof installationsQuerySchema>;

export const ISSUED_LICENSE_STATES = ['valid', 'expiring', 'grace', 'expired', 'revoked'] as const;

export const issuedLicenseSchema = z
  .object({
    id: z.string(),
    /** The key's `id` (kept on renewal). */
    ref: z.string(),
    licensee: z.string(),
    plan: z.enum(LICENSE_PLANS),
    features: z.array(z.string()),
    seats: z.number().int().nullable(),
    instance_id: z.string().nullable(),
    expires: z.string().nullable(),
    grace_days: z.number().int(),
    support: z.enum(SUPPORT_LEVELS),
    email: z.string().nullable(),
    state: z.enum(ISSUED_LICENSE_STATES),
    key: z.string(),
    issued_at: z.string(),
    revoked_at: z.string().nullable(),
    /** Expiry reminders already sent for the current expiry date ("days before" and when). */
    reminders: z.array(z.object({ days: z.number().int(), sent_at: z.string() })),
    /** Bought online through this payment provider (null = issued by hand). */
    payment_provider: z.string().nullable(),
  })
  .meta({ id: 'IssuedLicense' });
export type IssuedLicense = z.infer<typeof issuedLicenseSchema>;

export const issueLicenseSchema = z.object({
  plan: z.enum(LICENSE_PLANS),
  /** Preset from the edition in the form; the owner may change it. */
  features: z.array(featureKeySchema).max(100),
  licensee: z.string().trim().min(1).max(200),
  seats: z.number().int().min(1).max(10_000_000).nullable().optional(),
  /** null = never expires (Registered keys); Business / Enterprise default to a year in the form. */
  expires: z.iso.datetime({ offset: true }).nullable(),
  instance_id: instanceIdSchema.nullable().optional(),
  grace_days: z.number().int().min(0).max(365).optional(),
  support: z.enum(SUPPORT_LEVELS).optional(),
  email: z.email().max(320).nullable().optional(),
});
export type IssueLicense = z.infer<typeof issueLicenseSchema>;

export const changeLicensePlanSchema = z.object({
  plan: z.enum(LICENSE_PLANS),
  /** Absent = the new edition's features. */
  features: z.array(featureKeySchema).max(100).optional(),
});
export type ChangeLicensePlan = z.infer<typeof changeLicensePlanSchema>;

export const emailLicenseSchema = z.object({ to: z.email().max(320).optional() });

// --------------------------------------------------------------- license operations

/**
 * The license server's operations: expiry reminders (an hourly job emails the customer and the platform owner N days
 * before a license expires — on by default, 30 and 7 days) and the OPTIONAL online purchase (a payment provider —
 * Stripe first — OFF until the owner enters its keys; issuing and renewing by hand stays exactly as it is).
 */
export const LICENSE_REMINDER_DAYS_DEFAULT = [30, 7] as const;
/** The editions sold online (Registered is free — it comes from the questionnaire). */
export const PURCHASABLE_PLANS = ['business', 'enterprise'] as const;
export type PurchasablePlan = (typeof PURCHASABLE_PLANS)[number];
export const PAYMENT_PROVIDERS = ['stripe'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
/** A recurring price renews the license by itself every period; a one-time price buys one term. */
export const PAYMENT_MODES = ['subscription', 'payment'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const reminderDaysSchema = z
  .array(z.number().int().min(1).max(365))
  .min(1)
  .max(6)
  .refine((d) => new Set(d).size === d.length, 'reminder_days_duplicate');

/**
 * A seat tier of an edition (decision 7): the seats a purchase gives (null = unlimited), the
 * provider's price for it (empty = shown, not sold online) and the yearly price shown on the pricing page.
 */
export const purchaseTierSchema = z.object({
  seats: z.number().int().min(1).max(10_000_000).nullable(),
  price_id: z.string().trim().max(200),
  display_amount: z.number().min(0).max(100_000_000).nullable(),
});
export type PurchaseTier = z.infer<typeof purchaseTierSchema>;
export const PURCHASE_TIERS_MAX = 6;

/**
 * One sellable edition: the provider's price id, the seats a purchase gives (null = unlimited), and its kind. With
 * `tiers`, the buyer picks a tier and each tier has its own price and seats (the single price above is then unused);
 * `display_amount` / `currency` are the price shown for the single offering (null = not shown).
 */
export const purchasePlanSchema = z.object({
  price_id: z.string().trim().max(200),
  seats: z.number().int().min(1).max(10_000_000).nullable(),
  mode: z.enum(PAYMENT_MODES),
  display_amount: z.number().min(0).max(100_000_000).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  tiers: z.array(purchaseTierSchema).max(PURCHASE_TIERS_MAX),
});
export type PurchasePlan = z.infer<typeof purchasePlanSchema>;

/** GET /platform/license-ops (platform owner, license server only). Secrets are never returned — only whether set. */
export const licenseOpsSchema = z
  .object({
    reminders: z.object({ enabled: z.boolean(), days: z.array(z.number().int()) }),
    payments: z.object({
      provider: z.enum(PAYMENT_PROVIDERS),
      /** The owner's switch (off by default). */
      enabled: z.boolean(),
      secret_key_set: z.boolean(),
      webhook_secret_set: z.boolean(),
      plans: z.object({ business: purchasePlanSchema, enterprise: purchasePlanSchema }),
      /** On, both secrets set and at least one edition priced: the public purchase is live. */
      ready: z.boolean(),
      /** Paste into the provider's dashboard as the webhook endpoint. */
      webhook_url: z.string(),
      /** The public purchase page. */
      buy_url: z.string(),
    }),
  })
  .meta({ id: 'LicenseOps' });
export type LicenseOps = z.infer<typeof licenseOpsSchema>;

export const updateLicenseOpsSchema = z.object({
  reminders: z.object({ enabled: z.boolean().optional(), days: reminderDaysSchema.optional() }).optional(),
  payments: z
    .object({
      enabled: z.boolean().optional(),
      /** Write-only: a new value replaces the stored one; null clears it. */
      secret_key: z
        .string()
        .trim()
        .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,240}$/, 'stripe_secret_key_invalid')
        .nullable()
        .optional(),
      webhook_secret: z
        .string()
        .trim()
        .regex(/^whsec_[A-Za-z0-9+/=]{8,240}$/, 'stripe_webhook_secret_invalid')
        .nullable()
        .optional(),
      plans: z
        .object({
          business: purchasePlanSchema.partial().optional(),
          enterprise: purchasePlanSchema.partial().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type UpdateLicenseOps = z.infer<typeof updateLicenseOpsSchema>;

/** GET /public/licenses/purchase (license server): can a license be bought here, and which editions. */
export const publicPurchaseConfigSchema = z
  .object({
    available: z.boolean(),
    plans: z.array(
      z.object({
        plan: z.enum(PURCHASABLE_PLANS),
        seats: z.number().int().nullable(),
        /** The yearly price shown (null = not shown) and its currency. */
        amount: z.number().nullable(),
        currency: z.string(),
        /** The tiers on sale (empty = the single offering above). */
        tiers: z.array(
          z.object({ index: z.number().int(), seats: z.number().int().nullable(), amount: z.number().nullable() }),
        ),
      }),
    ),
  })
  .meta({ id: 'PublicPurchaseConfig' });
export type PublicPurchaseConfig = z.infer<typeof publicPurchaseConfigSchema>;

/** POST /public/licenses/checkout: start a purchase (the provider's hosted payment page). */
export const publicCheckoutSchema = z.object({
  plan: z.enum(PURCHASABLE_PLANS),
  /** The tier (its index) when the edition is sold in tiers. */
  tier: z
    .number()
    .int()
    .min(0)
    .max(PURCHASE_TIERS_MAX - 1)
    .optional(),
  /** Bind the key to this installation (optional — empty = the key works on any installation). */
  instance_id: instanceIdSchema.nullable().optional(),
  email: z.email().max(320).optional(),
  locale: z.enum(['he', 'en']).optional(),
});
export type PublicCheckout = z.infer<typeof publicCheckoutSchema>;
export const publicCheckoutResultSchema = z.object({ url: z.string() }).meta({ id: 'PublicCheckoutResult' });
