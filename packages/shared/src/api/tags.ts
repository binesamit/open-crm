// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { GROUP_PALETTE, groupColorInputSchema, type GroupColor } from '../colors';

/** Account-wide tags (03 §3.1): a name and a group-palette colour; `tags` columns hold their ids. */
export const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});
export type Tag = z.infer<typeof tagSchema>;
export const tagListSchema = z.object({ data: z.array(tagSchema) });

export const TAG_NAME_MAX = 60;
export const tagNameSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/^#+/, '').trim())
  .pipe(z.string().min(1).max(TAG_NAME_MAX));

export const createTagSchema = z.object({
  name: tagNameSchema,
  color: groupColorInputSchema.optional(),
});

/** The colour a new tag gets: stable per name, so the same tag looks the same wherever it is created. */
export const tagColorFor = (name: string): GroupColor => {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_PALETTE[h % GROUP_PALETTE.length]!;
};

/** POST /items/:id/cells/:columnId/vote — my vote on a vote column (03 §3.11): `true` casts it, `false` removes it. */
export const voteSchema = z.object({ vote: z.boolean() });
