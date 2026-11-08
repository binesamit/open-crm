// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { querySchema } from '../query/filter';

/**
 * Export a board to Excel / CSV (M6): what the view shows (its filter, search and sort, its column order) or the
 * selected items — as far as the person may see them.
 */
export const EXPORT_MAX_ITEMS = 10_000;

export const exportRequestSchema = z.object({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  query: querySchema.partial().optional(),
  /** The selection (Batch bar); omitted = every item the query matches. */
  item_ids: z.array(z.string()).max(5000).optional(),
  /** Column keys in the view's order (hidden ones left out); omitted = the board's visible columns. */
  columns: z.array(z.string()).max(300).optional(),
  /** Each item's subitems (every depth, D14) right under it; the sub-board's columns come after the board's. */
  include_subitems: z.boolean().default(false),
});
export type ExportRequest = z.infer<typeof exportRequestSchema>;
