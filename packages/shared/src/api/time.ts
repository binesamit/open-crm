// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** Time tracking API (03 §3.3, 06): entries of `time_tracking` columns; the cell is a cache. */
const person = z.object({ id: z.string(), name: z.string() }).nullable();

export const timeEntrySchema = z.object({
  id: z.string(),
  item_id: z.string(),
  column_id: z.string().describe('column key'),
  user: person,
  started_at: z.string(),
  ended_at: z.string().nullable(),
  duration_s: z.number().nullable().describe('null while running'),
  source: z.enum(['timer', 'manual', 'automation', 'import']),
  note: z.string().nullable(),
  billable: z.boolean(),
  edited_by: person,
  edited_at: z.string().nullable(),
});
export type TimeEntry = z.infer<typeof timeEntrySchema>;

export const startTimerSchema = z.object({ column_id: z.string(), note: z.string().max(500).optional() });

/** Manual entry: start + end, or start + duration (the end is computed). */
export const addTimeEntrySchema = z
  .object({
    column_id: z.string(),
    started_at: z.iso.datetime({ offset: true }),
    ended_at: z.iso.datetime({ offset: true }).optional(),
    duration_s: z.number().int().min(1).optional(),
    user_id: z.string().optional().describe('someone else (board owners / admins only)'),
    note: z.string().max(500).optional(),
    billable: z.boolean().optional(),
  })
  .refine((v) => !!v.ended_at !== !!v.duration_s, 'send either ended_at or duration_s');

export const updateTimeEntrySchema = z.object({
  started_at: z.iso.datetime({ offset: true }).optional(),
  ended_at: z.iso.datetime({ offset: true }).optional(),
  note: z.string().max(500).nullable().optional(),
  billable: z.boolean().optional(),
});

/** My running timers — any number at once (one per cell). */
export const runningTimerSchema = z.object({
  entry: timeEntrySchema,
  item: z.object({ id: z.string(), name: z.string(), board_id: z.string() }),
});
export type RunningTimer = z.infer<typeof runningTimerSchema>;

/** Board time report (03 §3.3): by person, item or day, over a range of local days. */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const timeReportQuerySchema = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
  group_by: z.enum(['user', 'item', 'day']).default('user'),
  user_id: z.string().optional(),
});
export type TimeReportQuery = z.infer<typeof timeReportQuerySchema>;
export const timeReportSchema = z.object({
  group_by: z.enum(['user', 'item', 'day']),
  from: z.string().nullable(),
  to: z.string().nullable(),
  total_s: z.number().int(),
  billable_s: z.number().int(),
  /** Timers still running are counted up to now. */
  running: z.number().int(),
  rows: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      duration_s: z.number().int(),
      billable_s: z.number().int(),
      entries: z.number().int(),
    }),
  ),
});
export type TimeReport = z.infer<typeof timeReportSchema>;
