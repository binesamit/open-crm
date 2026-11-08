// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { groupColorInputSchema, labelColorSchema } from '../colors';
import { tagNameSchema } from '../api/tags';
import { BULK_IMPORT_MAX_NEW_COLUMNS, NEW_COLUMN_PREFIX } from './import';
import { BULK_EDIT_MAX_ROWS } from './sheet';
import { SECRET_LIMITS } from '../columns/defs/secret';

/**
 * `POST /boards/:id/items/bulk-edit` (B2, "ייבוא ועריכה" → finish): the whole draft as ONE batch — new labels
 * first (and, from a file import, new columns before them), then new tags, then every row (an `item_id` updates that item, none creates one). One `batch_id`;
 * `POST /boards/:id/items/bulk-edit/:batch_id/undo` takes all of it back (cells, names, new items, new labels).
 */
export const bulkEditLabelSchema = z.object({
  column_id: z.string(),
  /** The id the cells below use; must be free in the column (409 `labels_changed` otherwise). */
  id: z.number().int().min(0),
  label: z.string().trim().min(1).max(100),
  /** status only: a palette key (a hex is read as the nearest key). */
  color: labelColorSchema.optional(),
  index: z.number().int().min(0).optional(),
});

/**
 * A new row's name in the request (B4), for a new subitem to hang under it in the same batch (`parent_ref`): the
 * sheet uses `__row_m<row>` for rows of the items sheet and `__row_s<row>` for the subitems sheet.
 */
export const NEW_ROW_PREFIX = '__row_';
const rowRefSchema = z.string().regex(new RegExp(`^${NEW_ROW_PREFIX}[a-z0-9_]{1,30}$`));

export const bulkEditRowSchema = z.object({
  item_id: z.string().optional(),
  /** New rows only: how new subitems of the same batch name this row as their parent. */
  ref: rowRefSchema.optional(),
  /** New rows only (default: the board's first group). */
  group_id: z.string().optional(),
  /** Required for a new row. */
  name: z.string().trim().min(1).max(255).optional(),
  /** Column key → value in the type's valueSchema (tags may be `{tags: [names]}`), null clears. */
  cells: z.record(z.string(), z.unknown()),
  /**
   * secret column key → the value, encrypted by the server and never echoed back (not in errors, the
   * activity log, webhooks or undo). A cell that already has a value is replaced only with `secrets_mode: replace`.
   */
  secrets: z.record(z.string(), z.string().min(1).max(SECRET_LIMITS.maxLength)).optional(),
});

/**
 * A column the batch creates first (B3 file import: "new column of type X"), through the same code as
 * `POST /boards/:id/columns`. `ref` (`__new_<n>`) stands for its key in `labels[].column_id` and `rows[].cells`.
 */
export const bulkEditColumnSchema = z.object({
  ref: z.string().regex(new RegExp(`^${NEW_COLUMN_PREFIX}[a-z0-9_]{1,20}$`)),
  title: z.string().trim().min(1).max(255),
  type: z.string(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A row of the subitems sheet (B4): no group; a new one needs a parent — an existing item / subitem
 * (`parent_item_id`) or a new row of the same batch (`parent_ref`). On an existing subitem a parent other than its
 * own moves it there (with its subitems), within the board's levels.
 */
export const bulkEditSubRowSchema = bulkEditRowSchema.omit({ group_id: true }).extend({
  parent_item_id: z.string().optional(),
  parent_ref: rowRefSchema.optional(),
});

/** The subitems sheet (B4): the sub-board's own new columns, new labels and rows, written in the same batch. */
export const bulkEditSubitemsSchema = z.object({
  columns: z.array(bulkEditColumnSchema).max(BULK_IMPORT_MAX_NEW_COLUMNS).optional(),
  labels: z.array(bulkEditLabelSchema).max(2000),
  rows: z.array(bulkEditSubRowSchema).max(BULK_EDIT_MAX_ROWS),
});

export const bulkEditSchema = z.object({
  columns: z.array(bulkEditColumnSchema).max(BULK_IMPORT_MAX_NEW_COLUMNS).optional(),
  labels: z.array(bulkEditLabelSchema).max(2000),
  tags: z.array(z.object({ name: tagNameSchema, color: groupColorInputSchema })).max(2000),
  /** Rows of the items sheet (may be empty when only the subitems sheet changed). */
  rows: z.array(bulkEditRowSchema).max(BULK_EDIT_MAX_ROWS),
  subitems: bulkEditSubitemsSchema.optional(),
  /**
   * Secret cells that already hold a value: `empty_only` (default) leaves them and counts them in
   * `secrets_skipped`; `replace` overwrites them — with the column's `change_requires_code`, after one fresh 2FA code
   * (`POST /secrets/verify`; an API token: the `secrets:read` scope). A replaced value can not come back by undo.
   */
  secrets_mode: z.enum(['empty_only', 'replace']).optional(),
});
export type BulkEditRequest = z.infer<typeof bulkEditSchema>;
export type BulkEditSubitems = z.infer<typeof bulkEditSubitemsSchema>;

export const bulkEditResultSchema = z.object({
  ok: z.literal(true),
  batch_id: z.string(),
  /** The batch's summary event (`batch.executed`, meta.action = `bulk_edit`). */
  event_id: z.string(),
  updated: z.number().int(),
  created: z.number().int(),
  labels_added: z.number().int(),
  columns_added: z.number().int(),
  /** Existing rows that are gone, not visible, or not the actor's to change (edit_assigned). */
  skipped: z.number().int(),
  /** The new items, in request order. */
  item_ids: z.array(z.string()),
  /** Subitems sheet (B4): subitems changed, created, moved to another parent; the new ones' ids. */
  sub_updated: z.number().int(),
  sub_created: z.number().int(),
  reparented: z.number().int(),
  subitem_ids: z.array(z.string()),
  /** r19relfilter: relation links left out because the column's filter does not offer them. */
  links_dropped: z.number().int().optional(),
  /** secret cells set into empty cells, replaced, and left alone (had a value, `empty_only`). */
  secrets_set: z.number().int().optional(),
  secrets_replaced: z.number().int().optional(),
  secrets_skipped: z.number().int().optional(),
});
export type BulkEditResult = z.infer<typeof bulkEditResultSchema>;

export const bulkEditUndoSchema = z.object({ force: z.boolean().optional() });
export const bulkEditUndoResultSchema = z.object({ ok: z.literal(true), undone: z.number().int() });
export type BulkEditUndoResult = z.infer<typeof bulkEditUndoResultSchema>;
