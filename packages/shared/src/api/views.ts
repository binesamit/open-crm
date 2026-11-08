// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { positionSchema } from './boards';
import { VIEW_TYPES, viewLayoutSchema, viewPrefsSchema, viewSettingsSchema } from '../views/settings';

/** Board views (15-VIEWS §8). */
export const viewSchema = z.object({
  id: z.string(),
  board_id: z.string(),
  type: z.enum(VIEW_TYPES),
  name: z.string(),
  position: z.string(),
  is_default: z.boolean(),
  is_system: z.boolean(),
  is_locked: z.boolean(),
  visibility: z.enum(['shared', 'private']),
  created_by: z.string().nullable(),
  revision: z.number().int(),
  settings: viewSettingsSchema,
  /** My personal overrides of this view (15 §1). */
  prefs: viewPrefsSchema,
  /** Pinned by me: pinned tabs always come first (my layout, `PUT /boards/:id/views/layout`). */
  pinned: z.boolean(),
  /** Whether I may save settings to this view (else: draft + "save as new view"), rename/lock it, delete it. */
  can_save: z.boolean(),
  can_manage: z.boolean(),
  can_delete: z.boolean(),
});
export type View = z.infer<typeof viewSchema>;

export const createViewSchema = z.object({
  type: z.enum(VIEW_TYPES).default('table'),
  name: z.string().trim().min(1).max(120),
  settings: viewSettingsSchema.optional(),
  visibility: z.enum(['shared', 'private']).default('shared'),
  position: positionSchema,
});

export const updateViewSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  settings: viewSettingsSchema.optional(),
  is_locked: z.boolean().optional(),
  is_default: z.boolean().optional(),
  /** Only private → shared ("make shared", 15 §3). */
  visibility: z.literal('shared').optional(),
  position: positionSchema,
});

export const viewListSchema = z.object({
  /** In my tab order: pinned first. */
  data: z.array(viewSchema),
  layout: viewLayoutSchema,
  /** The view to open: my last opened, else the board default. */
  current_view_id: z.string(),
});
