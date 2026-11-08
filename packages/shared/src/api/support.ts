// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Remote support access (08 §6, 05 §8): an account admin lets the platform's support (the platform
 * owner, or a support person by email) into the account for a while — view only unless the admin chooses edit —
 * revocable at once, expiring by itself, every request in the account's audit log. The platform owner gets no other
 * way in: "invite admin" to the owner's own address and the owner's recovery link need such a grant, or the
 * emergency path (a notice to the account's admins and a waiting period any admin can cancel).
 */

/** `view` = reads only (every change answers 405 support_read_only); `edit` = acts as an admin of the account. */
export const SUPPORT_MODES = ['view', 'edit'] as const;
export type SupportMode = (typeof SUPPORT_MODES)[number];

/** `platform` = whoever is a platform owner; `email` = the person signed in with this verified address. */
export const SUPPORT_GRANTEES = ['platform', 'email'] as const;
export type SupportGrantee = (typeof SUPPORT_GRANTEES)[number];

/** Hard bounds of every duration setting (hours): one hour to 30 days. The owner console picks within. */
export const SUPPORT_HOURS_MIN = 1;
export const SUPPORT_HOURS_MAX = 720;
export const supportHoursSchema = z.number().int().min(SUPPORT_HOURS_MIN).max(SUPPORT_HOURS_MAX);

/** Owner console → Platform settings → Support access (stored in `platform_settings.settings.support`). */
export const platformSupportSettingsSchema = z.object({
  /** The durations an admin may choose from (hours). */
  durations_hours: z.array(supportHoursSchema).min(1).max(12).default([1, 4, 24, 168]),
  /** The duration the grant form starts on. */
  default_duration_hours: supportHoursSchema.default(24),
  /** The longest grant on this platform (an account may allow less). */
  max_duration_hours: supportHoursSchema.default(168),
  /** Email the account's admins when a support session starts. */
  email_admins_on_entry: z.boolean().default(true),
  /** Write the pages and lists support opens (not only its changes) to the account's audit log. */
  log_views: z.boolean().default(true),
  /** A support session = requests with gaps shorter than this; a longer gap starts a new session (audit + email). */
  session_idle_minutes: z.number().int().min(5).max(1440).default(30),
  /** The emergency recovery link (no grant): the account's admins are told, and it opens after this wait. */
  emergency_delay_hours: z.number().int().min(1).max(168).default(24),
  /** The platform owner is not held to accounts' IP allowlists (the way back in when an account locks itself out). */
  owner_ip_exempt: z.boolean().default(true),
});
export type PlatformSupportSettings = z.infer<typeof platformSupportSettingsSchema>;

export const updatePlatformSupportSettingsSchema = z
  .object({
    durations_hours: z.array(supportHoursSchema).min(1).max(12),
    default_duration_hours: supportHoursSchema,
    max_duration_hours: supportHoursSchema,
    email_admins_on_entry: z.boolean(),
    log_views: z.boolean(),
    session_idle_minutes: z.number().int().min(5).max(1440),
    emergency_delay_hours: z.number().int().min(1).max(168),
    owner_ip_exempt: z.boolean(),
  })
  .partial();

/** Administration → Security → Support access (stored in `settings.security.support_access`). */
export const accountSupportSettingsSchema = z.object({
  /** May a grant let support change things (edit)? Off = view-only grants only. */
  allow_edit: z.boolean().default(false),
  /** The longest grant of this account (hours); the platform's maximum still applies. */
  max_hours: supportHoursSchema.default(168),
});
export type AccountSupportSettings = z.infer<typeof accountSupportSettingsSchema>;

/** POST /support-access */
export const createSupportGrantSchema = z
  .object({
    grantee: z.enum(SUPPORT_GRANTEES).default('platform'),
    /** For `grantee: email`. */
    email: z.email().toLowerCase().optional(),
    mode: z.enum(SUPPORT_MODES).default('view'),
    duration_hours: supportHoursSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .refine((v) => v.grantee !== 'email' || !!v.email, { message: 'email_required', path: ['email'] });
export type CreateSupportGrant = z.input<typeof createSupportGrantSchema>;

export const SUPPORT_GRANT_STATUSES = ['active', 'expired', 'revoked'] as const;
export const supportGrantSchema = z
  .object({
    id: z.string(),
    grantee: z.enum(SUPPORT_GRANTEES),
    email: z.string().nullable(),
    mode: z.enum(SUPPORT_MODES),
    reason: z.string().nullable(),
    status: z.enum(SUPPORT_GRANT_STATUSES),
    granted_by: z.object({ id: z.string(), name: z.string().nullable() }),
    created_at: z.string(),
    expires_at: z.string(),
    revoked_at: z.string().nullable(),
    revoked_by_name: z.string().nullable(),
    /** The last request support made under it (null = never used). */
    last_used_at: z.string().nullable(),
  })
  .meta({ id: 'SupportGrant' });
export type SupportGrant = z.infer<typeof supportGrantSchema>;

export const RECOVERY_REQUEST_STATUSES = ['waiting', 'ready', 'used', 'cancelled'] as const;
/** An emergency recovery link the platform owner asked for (no grant): opens after the wait unless an admin cancels. */
export const supportRecoveryRequestSchema = z
  .object({
    id: z.string(),
    account_id: z.string(),
    email: z.string(),
    reason: z.string(),
    status: z.enum(RECOVERY_REQUEST_STATUSES),
    requested_by_name: z.string().nullable(),
    created_at: z.string(),
    available_at: z.string(),
    cancelled_at: z.string().nullable(),
    cancelled_by_name: z.string().nullable(),
    used_at: z.string().nullable(),
  })
  .meta({ id: 'SupportRecoveryRequest' });
export type SupportRecoveryRequest = z.infer<typeof supportRecoveryRequestSchema>;

/** GET /support-access: grants (active first), emergency requests, and what the grant form may offer. */
export const supportAccessResponseSchema = z
  .object({
    grants: z.array(supportGrantSchema),
    recovery_requests: z.array(supportRecoveryRequestSchema),
    settings: accountSupportSettingsSchema,
    options: z.object({
      durations_hours: z.array(z.number().int()),
      default_duration_hours: z.number().int(),
      max_hours: z.number().int(),
      allow_edit: z.boolean(),
      /** Every duration the platform offers (the account's maximum is chosen among these). */
      platform_durations_hours: z.array(z.number().int()),
    }),
  })
  .meta({ id: 'SupportAccess' });
export type SupportAccessResponse = z.infer<typeof supportAccessResponseSchema>;

/** The support session of this request (GET /auth/me `account.support`, /me/accounts): drives the banner. */
export const supportSessionSchema = z.object({
  grant_id: z.string(),
  mode: z.enum(SUPPORT_MODES),
  expires_at: z.string(),
  /** The support ticket the grant was approved from: the banner shows its number. */
  ticket_id: z.string().nullable().optional(),
  ticket_number: z.number().int().nullable().optional(),
});
export type SupportSession = z.infer<typeof supportSessionSchema>;

/** POST /platform/accounts/{id}/emergency-recovery */
export const createRecoveryRequestSchema = z.object({
  email: z.email().toLowerCase(),
  reason: z.string().trim().min(1).max(500),
});
