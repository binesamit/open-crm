// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { querySchema } from '../query/filter';
import { SUMMARY_FNS } from '../query/summary';
import { bulkItemsSchema } from './boards';

/**
 * Windowed boards (perf review §7.1): a board with more items than the threshold is not loaded whole. The table
 * asks the server for the view's **outline** — every matching item id in view order, per section (board group or
 * bucket of a grouping by column), with each section's footer summaries — and loads the rows themselves in
 * windows as they scroll into view (`GET /boards/:id/items?ids=`). Filter, sort, grouping, search and summaries
 * run on the server with the same query engine (13-FILTERS); the browser never holds the whole board.
 * Boards at or below the threshold load whole and behave exactly as before.
 */

/** Boards with more (live, top-level) items than this open windowed — unless the server is configured otherwise. */
export const WINDOW_MIN_ITEMS = 3000;
/** Rows per window request (the `?ids=` limit). */
export const WINDOW_PAGE = 200;
/** At most this many ids in one outline (a board larger than this is cut — `truncated`). */
export const OUTLINE_MAX_IDS = 100_000;
/** Above this many matches an outline leaves out the footers of computed columns (`skipped_summaries`). */
export const OUTLINE_COMPUTED_MAX = 5000;

/** `GET /boards/:id/items?window=1` on a board above the threshold: no rows, only its size. */
export const windowedInfoSchema = z.object({ total: z.number().int(), threshold: z.number().int() });
export type WindowedInfo = z.infer<typeof windowedInfoSchema>;

const summaryRequestSchema = z.object({
  column_id: z.string().min(1).max(64),
  /** The view's footer choice; absent = the column type's default. */
  fn: z.enum(SUMMARY_FNS).optional(),
});

/** `POST /boards/:id/items/outline`: the view's query plus the summaries its footers and group titles show. */
export const outlineRequestSchema = z.object({
  query: querySchema.default(querySchema.parse({})),
  /** Footer summaries per section (the table's visible columns). */
  summaries: z.array(summaryRequestSchema).max(100).default([]),
  /** N3: the one field summarised next to each group's name. */
  group_summary: summaryRequestSchema.nullable().optional(),
  /**
   * Group sections by this column instead of the query's `group_by` (Kanban lanes by its lane column). Buckets
   * of a status / dropdown are keyed by label id, the empty one `__empty__` — the Kanban's lane keys.
   */
  lanes_by: z.string().min(1).max(64).optional(),
  /**
   * `groups` (the table): sections by board group, in the board's group order. `flat` (Cards, Calendar): one
   * section (key `''`) in sort / position order across groups. A grouping by column always buckets.
   */
  layout: z.enum(['groups', 'flat']).default('groups'),
});
export type OutlineRequest = z.infer<typeof outlineRequestSchema>;
export type OutlineRequestInput = z.input<typeof outlineRequestSchema>;

export const columnSummarySchema = z.union([
  z.object({
    kind: z.literal('battery'),
    total: z.number().int(),
    segments: z.array(z.object({ key: z.string(), label: z.string(), color: z.string(), count: z.number().int() })),
  }),
  z.object({
    kind: z.literal('value'),
    fn: z.enum(['sum', 'avg', 'median', 'min', 'max', 'count']),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('done'),
    done: z.number().int(),
    total: z.number().int(),
    fn: z.literal('filled').optional(),
  }),
  z.object({
    kind: z.literal('range'),
    from: z.string(),
    to: z.string(),
    fn: z.enum(['earliest', 'latest']).optional(),
  }),
]);

export const outlineSectionSchema = z.object({
  /** A board group's id, or the bucket key of a grouping by column (`__empty__` = no value). */
  key: z.string(),
  /** The bucket's label (grouped by column); the browser shows its own names for people, tags and dates. */
  label: z.string().optional(),
  color: z.string().optional(),
  /** Every matching item of the section, in view order. */
  ids: z.array(z.string()),
  /** Footer summaries by column id (null = nothing to show). */
  summaries: z.record(z.string(), columnSummarySchema.nullable()),
  group_summary: columnSummarySchema.nullable().optional(),
  /** A nested grouping (ק3): the section's level (0 = the first); absent = one level. */
  level: z.number().int().min(0).max(2).optional(),
  /** A parent level's number of items (its `ids` are empty: its children carry them). */
  count: z.number().int().optional(),
});
export type OutlineSection = z.infer<typeof outlineSectionSchema>;

export const outlineSchema = z
  .object({
    /** Items matching the query (an item in two buckets counts once). */
    total: z.number().int(),
    sections: z.array(outlineSectionSchema),
    /** Grouped by this column (the query's `group_by` or `lanes_by`); absent = by board group. */
    grouped_by: z.string().optional(),
    /** The match list was cut at OUTLINE_MAX_IDS. */
    truncated: z.boolean().optional(),
    /**
     * Summaries of computed columns (formula, mirror…) not calculated: more than OUTLINE_COMPUTED_MAX matches —
     * each would compute the column for every item (~2 s on 30k items, on every toolbar change).
     */
    skipped_summaries: z.array(z.string()).optional(),
  })
  .meta({ id: 'BoardOutline' });
export type Outline = z.infer<typeof outlineSchema>;

/** `POST /boards/:id/items/bulk-query`: a batch action on every item matching a query (not-loaded rows too). */
export const BULK_QUERY_MAX = 50_000;
export const bulkQuerySchema = z.object({ query: querySchema, action: bulkItemsSchema.shape.action });
export type BulkQueryRequest = z.infer<typeof bulkQuerySchema>;
