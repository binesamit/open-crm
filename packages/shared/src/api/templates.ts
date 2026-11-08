// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** POST /templates/:key/duplicate (fix2): a copy as a new template of the account; name defaults to "<name> (עותק)". */
export const duplicateTemplateSchema = z.object({ name: z.string().trim().min(1).max(255).optional() });

/** GET /templates/hidden: built-in templates removed from this account (admins may restore them). */
export const hiddenTemplateSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

/**
 * POST /templates/:key/draft (fix3): my working board of the template — the open one, else a new one. It is
 * hidden from every list and saved back with POST /boards/:id/template-draft/save.
 */
export const startTemplateDraftSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  /** Where the working board lives; default: the first workspace I see. */
  workspace_id: z.string().optional(),
});
export const templateDraftSchema = z.object({ board_id: z.string() });

/** POST /boards/:id/template-draft/save: over the template, then the working board goes (not to the trash). */
export const saveTemplateDraftSchema = z.object({
  /** Default: whether the template had items. */
  with_items: z.boolean().optional(),
});
