// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** Trash, restore and undo (07 §5.2–5.3, 06 §2.20). */
export const TRASH_OBJECT_TYPES = [
  'workspace',
  'folder',
  'board',
  'group',
  'item',
  'column',
  'view',
  'update',
  'doc',
  'dashboard',
  /** A file removed from a files cell, with all its versions. */
  'file',
] as const;
export type TrashObjectType = (typeof TRASH_OBJECT_TYPES)[number];

/**
 * The "undo" toast shows for a few seconds and fades (07 §5.3); Ctrl+Z still undoes the last action for a
 * minute, and the activity log for 7 days.
 */
export const UNDO_TOAST_SECONDS = 8;
export const UNDO_SHORTCUT_SECONDS = 60;
export const UNDO_WINDOW_DAYS = 7;

export const trashEntrySchema = z.object({
  id: z.string(),
  object_type: z.enum(TRASH_OBJECT_TYPES),
  object_id: z.string(),
  name: z.string(),
  board_id: z.string().nullable(),
  board_name: z.string().nullable(),
  /** A file (`object_type: 'file'`): the item whose cell it was removed from. */
  item_id: z.string().nullable().optional(),
  item_name: z.string().nullable().optional(),
  /** A file: how many versions it has (the root included). */
  version_count: z.number().int().optional(),
  deleted_by: z.object({ id: z.string(), name: z.string() }).nullable(),
  deleted_at: z.string(),
  purge_after: z.string(),
});
export type TrashEntry = z.infer<typeof trashEntrySchema>;

export const trashListSchema = z.object({ data: z.array(trashEntrySchema) });

/** Answer of every delete-to-trash endpoint: the event to pass to `POST /activity/:id/undo`. */
export const deletedSchema = z.object({ ok: z.literal(true), event_id: z.string() });
export type Deleted = z.infer<typeof deletedSchema>;

export const restoredSchema = z.object({
  ok: z.literal(true),
  object_type: z.enum(TRASH_OBJECT_TYPES),
  object_id: z.string(),
  board_id: z.string().nullable(),
});

/** Archive page (07 §5.1). */
export const ARCHIVE_TYPES = ['item', 'group', 'board'] as const;
export type ArchiveType = (typeof ARCHIVE_TYPES)[number];
export const archiveEntrySchema = z.object({
  type: z.enum(ARCHIVE_TYPES),
  id: z.string(),
  name: z.string(),
  /** The board to open (a subitem's root board). */
  board_id: z.string(),
  board_name: z.string().nullable(),
  archived_at: z.string(),
  archived_by: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type ArchiveEntry = z.infer<typeof archiveEntrySchema>;
export const archiveListSchema = z.object({ data: z.array(archiveEntrySchema) });
export const unarchivedSchema = z.object({ ok: z.literal(true), board_id: z.string() });

export const undoRequestSchema = z.object({
  /** Undo even though the value changed since (07 §5.3 "הערך השתנה מאז"). */
  force: z.boolean().optional(),
});
export const undoResultSchema = z.object({
  ok: z.literal(true),
  undone: z.number().int(),
  /** The compensating events — what a redo undoes, or (after a redo) what Ctrl+Z undoes next. */
  event_ids: z.array(z.string()),
});
