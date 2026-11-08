// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { labelColorSchema } from '../colors';

/**
 * Column type conversion API (D28, the planning notes "COLUMN-CONVERSION"). `POST /boards/:id/columns/:col/convert`
 * with `dry_run: true` = the preview (nothing written); without it = the conversion, which must carry the
 * preview's `fingerprint` (the preview the user saw is the conversion that runs — 409 `preview_stale` when the
 * column changed since). A board above `CONVERT_SYNC_MAX_CELLS` cells converts in the background (a job,
 * windows of `CONVERT_WINDOW` cells, progress on the board's live channel).
 */
export const CONVERT_SYNC_MAX_CELLS = 5000;
export const CONVERT_WINDOW = 1000;
/** How long the original values are kept for "restore from backup" (product decision 5); admins may change it. */
export const CONVERT_BACKUP_DAYS_DEFAULT = 90;
export const CONVERT_BACKUP_DAYS = [30, 90, 365, 0] as const;

export const convertOptionsSchema = z
  .object({
    date_order: z.enum(['dmy', 'mdy']).optional(),
    timeline_side: z.enum(['start', 'end']).optional(),
    people_as: z.enum(['name', 'email']).optional(),
    number_unit: z.boolean().optional(),
    rating_max: z.union([z.literal(3), z.literal(4), z.literal(5), z.literal(10)]).optional(),
    skip_labels: z.array(z.string().max(100)).max(1000).optional(),
    /** New label name → a palette key (a hex is read as the nearest key). */
    label_colors: z.record(z.string().max(100), labelColorSchema).optional(),
  })
  .meta({ id: 'ConvertOptions' });

export const convertRequestSchema = z.object({
  to_type: z.string().min(1).max(32),
  options: convertOptionsSchema.optional(),
  /** true = the preview only. */
  dry_run: z.boolean().optional(),
  /** The preview's fingerprint (required to convert). */
  fingerprint: z.string().max(80).optional(),
});
export type ConvertRequest = z.infer<typeof convertRequestSchema>;

export const conversionCountsSchema = z.object({
  items: z.number(),
  converted: z.number(),
  empty: z.number(),
  failed: z.number(),
  partial: z.number(),
});

const sampleSchema = z.object({
  item_id: z.string(),
  item_name: z.string(),
  before: z.string(),
  after: z.string(),
  partial: z.boolean().optional(),
  reason: z.string().optional(),
});

const newLabelSchema = z.object({ name: z.string(), color: z.string().optional(), count: z.number() });

/** Something that depends on the column, and what the conversion does to it (plan §6). */
export const DEPENDENT_KINDS = [
  'formula',
  'mirror',
  'view',
  'automation',
  'widget',
  'ai_column',
  'column_setting',
  'extension',
  'form',
  'import',
  'webhook',
] as const;
export const DEPENDENT_ACTIONS = ['kept', 'updated', 'disabled', 'review'] as const;
export const conversionDependentSchema = z.object({
  kind: z.enum(DEPENDENT_KINDS),
  id: z.string(),
  name: z.string(),
  board_id: z.string().nullable(),
  action: z.enum(DEPENDENT_ACTIONS),
  /** Why (`formula_kind`, `rules_disabled`, `recipe_breaks`, `needs_choice`, `rerun`, …). */
  detail: z.string(),
  /** Numbers / paths behind the detail (rules disabled, kinds before / after…). */
  info: z.record(z.string(), z.unknown()).optional(),
});
export type ConversionDependent = z.infer<typeof conversionDependentSchema>;

export const conversionPreviewSchema = z.object({
  column_id: z.string(),
  from_type: z.string(),
  to_type: z.string(),
  counts: conversionCountsSchema,
  samples: z.object({ converted: z.array(sampleSchema), failed: z.array(sampleSchema) }),
  new_labels: z.array(newLabelSchema),
  new_tags: z.array(newLabelSchema),
  /** New labels / tags removed by the user or over the status limit (their cells fail). */
  skipped_labels: z.array(newLabelSchema),
  /** The pair's preview options (only these apply) and their values (defaults filled in). */
  option_keys: z.array(z.string()),
  options: convertOptionsSchema,
  to_settings: z.record(z.string(), z.unknown()),
  dependents: z.array(conversionDependentSchema),
  /** Runs as a background job (a large board). */
  background: z.boolean(),
  fingerprint: z.string(),
});
export type ConversionPreview = z.infer<typeof conversionPreviewSchema>;

export const CONVERSION_STATUSES = ['running', 'done', 'failed', 'undone'] as const;
export const conversionSchema = z
  .object({
    id: z.string(),
    board_id: z.string(),
    column_id: z.string(),
    /** convert = a type change; restore = back to the original type from a conversion's backup. */
    kind: z.enum(['convert', 'restore']),
    restore_of: z.string().nullable(),
    from_type: z.string(),
    to_type: z.string(),
    status: z.enum(CONVERSION_STATUSES),
    /** Cells to process / processed (progress of a background conversion). */
    total: z.number(),
    done: z.number(),
    counts: conversionCountsSchema,
    dependents: z.array(conversionDependentSchema),
    new_labels: z.array(newLabelSchema),
    event_id: z.string().nullable(),
    error: z.string().nullable(),
    created_by: z.string().nullable(),
    created_at: z.string(),
    finished_at: z.string().nullable(),
    undone_at: z.string().nullable(),
    /** The original values are still kept (until `backup_until`; null = kept until removed). */
    backup: z.boolean(),
    backup_until: z.string().nullable(),
    /** The failed cells are marked on the board (until someone clears the marks). */
    failed_marked: z.boolean(),
  })
  .meta({ id: 'ColumnConversion' });
export type ColumnConversion = z.infer<typeof conversionSchema>;

/** The failed cells of a board's recent conversions, for the marks in the table and the "failed" filter. */
export const failedConversionsSchema = z.object({
  data: z.array(
    z.object({
      conversion_id: z.string(),
      column_id: z.string(),
      from_type: z.string(),
      to_type: z.string(),
      created_at: z.string(),
      /** item id → the original value as text. */
      items: z.record(z.string(), z.string()),
    }),
  ),
});
export type FailedConversions = z.infer<typeof failedConversionsSchema>;

export const conversionUndoSchema = z.object({ force: z.boolean().optional() });
export const conversionRestoreSchema = z.object({
  dry_run: z.boolean().optional(),
  fingerprint: z.string().max(80).optional(),
  /** Overwrite values edited since the conversion (they go to the restore's own backup). */
  force: z.boolean().optional(),
});
export const conversionSettingsSchema = z.object({
  /** Days the original values are kept; 0 = until removed by hand. */
  backup_days: z.union([z.literal(30), z.literal(90), z.literal(365), z.literal(0)]),
});
export type ConversionSettings = z.infer<typeof conversionSettingsSchema>;
