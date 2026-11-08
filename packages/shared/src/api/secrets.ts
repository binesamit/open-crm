// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { SECRET_LIMITS } from '../columns/defs/secret';

/**
 * Secret columns: set / clear a value, the two-factor step-up, reveal, the copy event and the
 * admins' reveal log. The value travels only in `setSecretSchema` (in) and `secretRevealSchema` (out, once).
 */
export const setSecretSchema = z.object({
  /** The new value; null (or empty) clears it. */
  value: z.string().max(SECRET_LIMITS.maxLength).nullable(),
});

export const secretVerifySchema = z.object({
  code: z.string().trim().min(6).max(12),
});

/** My state for revealing: 2FA on, and until when my last fresh code counts (per column: its own minutes). */
export const secretStatusSchema = z.object({
  two_factor_enabled: z.boolean(),
  /** When I last entered a fresh code in this session (null = never / signed in again since). */
  verified_at: z.string().nullable(),
});
export type SecretStatus = z.infer<typeof secretStatusSchema>;

export const secretRevealSchema = z.object({
  value: z.string(),
  /** How long the app shows it (the column's setting). */
  reveal_seconds: z.number().int(),
  copy_allowed: z.boolean(),
});
export type SecretReveal = z.infer<typeof secretRevealSchema>;

export const SECRET_LOG_ACTIONS = [
  'reveal',
  'copy',
  'set',
  'cleared',
  'settings',
  'verify',
  'verify_failed',
  'alert',
] as const;
export type SecretLogAction = (typeof SECRET_LOG_ACTIONS)[number];

export const secretLogQuerySchema = z.object({
  actor_id: z.string().max(26).optional(),
  board_id: z.string().max(26).optional(),
  action: z.enum(SECRET_LOG_ACTIONS).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

export const secretLogEntrySchema = z.object({
  id: z.string(),
  created_at: z.string(),
  action: z.enum(SECRET_LOG_ACTIONS),
  actor_id: z.string().nullable(),
  actor_name: z.string().nullable(),
  board_id: z.string().nullable(),
  board_name: z.string().nullable(),
  item_id: z.string().nullable(),
  item_name: z.string().nullable(),
  column_title: z.string().nullable(),
  /** A secret update's id when the action was on an update, not a column; else null / absent. */
  update_id: z.string().nullable().optional(),
  /** An API token (with `secrets:read`) instead of a person's session. */
  via_token: z.boolean(),
  ip: z.string().nullable(),
});
export type SecretLogEntry = z.infer<typeof secretLogEntrySchema>;

export const secretLogPageSchema = z.object({
  data: z.array(secretLogEntrySchema),
  total: z.number().int(),
  page: z.number().int(),
  page_size: z.number().int(),
});
export type SecretLogPage = z.infer<typeof secretLogPageSchema>;
