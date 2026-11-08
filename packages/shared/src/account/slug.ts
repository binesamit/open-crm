// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** Path segments that can never be an account slug, because `/a/<slug>` must not shadow app routes (D12, 02 §2.1). */
export const RESERVED_ACCOUNT_SLUGS = new Set([
  'owner',
  'admin',
  'api',
  'auth',
  'portal',
  'me',
  'f',
  'www',
  'a',
  'login',
  'invite',
]);

export const accountSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'slug: 3–63 chars, lowercase letters, digits and dashes')
  .refine((slug) => !RESERVED_ACCOUNT_SLUGS.has(slug), { message: 'slug_reserved' });

export const accountStatusSchema = z.enum(['active', 'suspended']);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

/** Header that selects the account for every account-scoped API call (D12, 06-API §1.1). */
export const ACCOUNT_HEADER = 'x-account-id';
