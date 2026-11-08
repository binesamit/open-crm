// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { querySchema } from '../query/filter';
import { viewChartSchema } from '../views/chart';
import { popupSubitemsWriteSchema } from '../workflows/status-workflow';

/** M8 ד9–ד11: the Files and Chart views of a board, and a button column's click. */

export const boardFileSchema = z.object({
  /** The file (asset) id — `GET /files/:id` gives its link. */
  id: z.string(),
  name: z.string(),
  size: z.number(),
  mime: z.string(),
  created_at: z.string(),
  uploaded_by: z.string().nullable(),
  item_id: z.string(),
  item_name: z.string(),
  /** A subitem's parent (its files show on the parent board's view). */
  parent_item_id: z.string().nullable(),
  /** In a file column, or attached to an update / reply. */
  source: z.enum(['cell', 'update']),
  column_id: z.string().nullable(),
  column_title: z.string().nullable(),
  update_id: z.string().nullable(),
});
export type BoardFile = z.infer<typeof boardFileSchema>;
export const boardFilesSchema = z.object({ data: z.array(boardFileSchema), total: z.number().int() });

export const chartRequestSchema = z.object({
  query: querySchema.default(querySchema.parse({})),
  chart: viewChartSchema.default(viewChartSchema.parse({})),
});
export type ChartRequest = z.input<typeof chartRequestSchema>;

const bucket = z.object({ key: z.string(), label: z.string(), color: z.string().nullable() });
export const boardChartDataSchema = z.object({
  series: z.array(bucket),
  rows: z.array(bucket.extend({ values: z.record(z.string(), z.number()) })),
  unit: z.string().nullable(),
  /** Items the chart read (a large board: the first ones). */
  items: z.number().int(),
  truncated: z.boolean(),
});

/** phase 2: a popup button's answers — the popup's columns only (column id → value), and its note. */
export const buttonClickSchema = z.object({
  cells: z.record(z.string(), z.unknown()).optional(),
  note: z.string().trim().max(5000).optional(),
  /** subitems added and filled in from the popup (its subitem columns only). */
  subitems: popupSubitemsWriteSchema.optional(),
  /** P1-03 create_linked: the linked item the popup filled in (the one `reuse` found); unset = create a new one. */
  target_item_id: z.string().min(1).max(64).optional(),
});
export type ButtonClick = z.infer<typeof buttonClickSchema>;

/** P1-03 create_linked: the item made or filled in by the click. */
export const buttonLinkedSchema = z.object({
  item_id: z.string(),
  board_id: z.string(),
  name: z.string(),
  created: z.boolean(),
});
export type ButtonLinked = z.infer<typeof buttonLinkedSchema>;

export const buttonResultSchema = z.object({
  event_id: z.string(),
  batch_id: z.string(),
  /** open_url: the link to open (http/https), else null. */
  url: z.string().nullable(),
  /** set_values: the columns written, and those that could not be (bad text, restricted …). */
  written: z.array(z.string()),
  skipped: z.array(z.object({ column_id: z.string(), reason: z.string() })),
  /** create_linked: the item made / filled in. */
  linked: buttonLinkedSchema.nullable().optional(),
});
export type ButtonResultDto = z.infer<typeof buttonResultSchema>;
