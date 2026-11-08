// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Field shapes several API schemas share (audit 2026-10-10 duplication #22) — written once here.
 */

/** An http(s) URL a server may be sent to: no credentials, no fragment, at most 2000 characters. */
export const httpUrl = z
  .string()
  .max(2000)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.hash;
    } catch {
      return false;
    }
  }, 'url_invalid');

/** A trimmed, non-empty text of at most `max` characters. */
export const trimmed = (max: number) => z.string().trim().min(1).max(max);
