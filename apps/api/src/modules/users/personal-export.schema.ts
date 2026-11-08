// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';

/**
 * The personal data export's envelope for the API reference (privacy). The sections are described in
 * `personal-export.ts`; the reference shows the envelope and lets the rest through.
 */
export const personalExportSchema = z
  .object({
    format: z.literal('bines-personal-export'),
    version: z.number().int(),
    generated_at: z.string(),
    scope: z.enum(['account', 'all_accounts']),
    truncated: z.boolean(),
  })
  .loose()
  .openapi('PersonalExport');
