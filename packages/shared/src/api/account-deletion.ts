// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Account data export and account deletion. An admin downloads everything the account holds (one
 * ZIP, built in the background, its link valid for a while), then may schedule the account's deletion: the name typed
 * again and a fresh two-factor code. The account is then locked (like a closed one) for a grace period — admins can
 * cancel — and purged for good when it ends. The periods are the owner's (platform settings → `account_deletion`);
 * accounts the owner console soft-deleted are purged automatically only when the owner turned that on.
 */

/** Defaults and bounds of the owner's settings (days). */
export const ACCOUNT_DELETION_GRACE_DAYS = 30;
export const ACCOUNT_DELETION_GRACE_RANGE = [7, 90] as const;
export const ACCOUNT_EXPORT_DAYS = 7;
export const ACCOUNT_EXPORT_DAYS_RANGE = [1, 30] as const;
/** Reminder emails to the admins this many days before the deletion. */
export const ACCOUNT_DELETION_REMINDER_DAYS = [7, 1] as const;

export const accountDeletionSettingsSchema = z.object({
  /** Days between scheduling and the final deletion (admins can cancel meanwhile). */
  grace_days: z
    .number()
    .int()
    .min(ACCOUNT_DELETION_GRACE_RANGE[0])
    .max(ACCOUNT_DELETION_GRACE_RANGE[1])
    .default(ACCOUNT_DELETION_GRACE_DAYS),
  /** Days a full export stays downloadable (then its file is removed). */
  export_days: z
    .number()
    .int()
    .min(ACCOUNT_EXPORT_DAYS_RANGE[0])
    .max(ACCOUNT_EXPORT_DAYS_RANGE[1])
    .default(ACCOUNT_EXPORT_DAYS),
  /**
   * Whether the hourly sweep also purges for good the accounts the owner console soft-deleted, once `grace_days`
   * passed. Off by default: only scheduled deletions are purged automatically; the owner's "delete now" stays.
   */
  purge_console_deleted: z.boolean().default(false),
});
export type AccountDeletionSettings = z.infer<typeof accountDeletionSettingsSchema>;

export const ACCOUNT_EXPORT_STATUSES = ['pending', 'running', 'ready', 'failed', 'expired'] as const;
export type AccountExportStatus = (typeof ACCOUNT_EXPORT_STATUSES)[number];

/** What one export holds (shown next to the download). */
export const accountExportSummarySchema = z.object({
  boards: z.number(),
  docs: z.number(),
  files: z.number(),
  users: z.number(),
  /** Boards / docs the requester may not read (private ones they are not in) — left out, by name. */
  skipped: z.array(z.string()),
});

export const accountExportSchema = z.object({
  id: z.string(),
  status: z.enum(ACCOUNT_EXPORT_STATUSES),
  requested_by: z.object({ id: z.string(), name: z.string() }).nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
  /** Until when the file can be downloaded (ISO); null while it is being built. */
  expires_at: z.string().nullable(),
  size_bytes: z.number().nullable(),
  summary: accountExportSummarySchema.nullable(),
  error: z.string().nullable(),
});
export type AccountExport = z.infer<typeof accountExportSchema>;

export const accountExportListSchema = z.object({ data: z.array(accountExportSchema) });
export const accountExportLinkSchema = z.object({ url: z.string(), expires_at: z.string() });

/** The account's deletion state (GET /account-deletion). */
export const accountDeletionStatusSchema = z.object({
  /** Null = not scheduled. */
  scheduled_at: z.string().nullable(),
  /** When the data is deleted for good (ISO); null = not scheduled. */
  due_at: z.string().nullable(),
  requested_by: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Does the person asking have two-factor sign-in turned on (it is required to schedule)? */
  two_factor_enabled: z.boolean(),
  grace_days: z.number(),
  export_days: z.number(),
});
export type AccountDeletionStatus = z.infer<typeof accountDeletionStatusSchema>;

/** POST /account-deletion: the account's name typed again and a fresh code from the authenticator app. */
export const scheduleAccountDeletionSchema = z.object({
  confirm_name: z.string().max(200),
  code: z.string().trim().min(6).max(12),
});
export type ScheduleAccountDeletion = z.infer<typeof scheduleAccountDeletionSchema>;

/** Owner console: an account waiting for its deletion. */
export const pendingDeletionSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  scheduled_at: z.string(),
  due_at: z.string(),
  requested_by: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
});
export type PendingDeletion = z.infer<typeof pendingDeletionSchema>;

/** Owner console "delete now": the account's address typed again and the owner's fresh code. */
export const purgeAccountNowSchema = z.object({
  confirm_slug: z.string().max(100),
  code: z.string().trim().min(6).max(12),
});

/** The name comparison of the confirmation: spaces around it and letter case do not count. */
export const deletionNameMatches = (typed: string, name: string) =>
  typed.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase();
