// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Password length (product decision: "הסיסמה לא צריכה להיות עם 10 תווים, שתהיה עד 8 תווים"): the minimum is a
 * setting, not a constant. The platform owner sets the default (owner console → Platform settings, 8 unless
 * changed); an account admin may set the account's own (Administration → Security; empty = the platform's).
 *
 * Which one applies (apps/api/src/auth/password-policy.ts):
 * - accepting an invitation with a new password → the inviting account's;
 * - setting / changing / resetting the password of an existing person → the strictest (longest) of the accounts
 *   they are an active member of (one password opens all of them), the platform's when they have none.
 * Existing passwords keep working: the rule is checked only when a password is chosen.
 */
export const PASSWORD_MIN_FLOOR = 6;
export const PASSWORD_MIN_CEILING = 64;
export const DEFAULT_PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordMinLengthSchema = z.number().int().min(PASSWORD_MIN_FLOOR).max(PASSWORD_MIN_CEILING);

/** The shape every new password has whatever the setting (the configured minimum is enforced on top, server side). */
export const newPasswordSchema = z.string().min(PASSWORD_MIN_FLOOR).max(PASSWORD_MAX_LENGTH);

/** What is wrong with a new password under a minimum (null = fine). */
export const passwordLengthProblem = (password: string, minLength: number): 'too_short' | 'too_long' | null =>
  password.length < minLength ? 'too_short' : password.length > PASSWORD_MAX_LENGTH ? 'too_long' : null;
