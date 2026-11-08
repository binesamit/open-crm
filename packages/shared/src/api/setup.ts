// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_FLOOR } from './password';

/**
 * First-run setup (docs/SELF-HOSTING.md "Install in 1 minute"): while the installation has no user at all, the
 * browser shows "Create the owner account" — the first person becomes the platform owner and the first admin of the
 * first account. Once anyone exists it is closed for good (409 `setup_done`).
 */
export const setupStatusSchema = z
  .object({
    /** No user exists yet: the sign-in screen sends visitors to /setup. */
    required: z.boolean(),
    /** Email is configured (magic links, password reset, invitation emails); off = the owner console says how. */
    email_enabled: z.boolean(),
    /** The owner's minimum password length (the platform default). */
    password_min_length: z.number().int(),
  })
  .meta({ id: 'SetupStatus' });
export type SetupStatus = z.infer<typeof setupStatusSchema>;

export const SETUP_PRODUCT_NAME_MAX = 60;

export const setupOwnerSchema = z
  .object({
    email: z.email().max(254),
    password: z.string().min(PASSWORD_MIN_FLOOR).max(PASSWORD_MAX_LENGTH),
    name: z.string().trim().min(1).max(120),
    /** White-label: the product's name (owner console → Platform settings). Empty = the default name. */
    product_name: z.string().trim().max(SETUP_PRODUCT_NAME_MAX).optional(),
    /** The owner's interface language. */
    locale: z.enum(['he', 'en']).optional(),
  })
  .meta({ id: 'SetupOwner' });
export type SetupOwner = z.infer<typeof setupOwnerSchema>;

export const setupResultSchema = z
  .object({
    ok: z.literal(true),
    /** The first account, which the owner now administers (the session cookie is set). */
    account: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  })
  .meta({ id: 'SetupResult' });
export type SetupResult = z.infer<typeof setupResultSchema>;
