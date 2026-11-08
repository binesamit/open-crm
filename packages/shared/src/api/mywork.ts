// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { type DateEnv, relativeDateBucket } from '../query/dates';
import { cellSchema, columnSchema } from './boards';

/**
 * My Work (07 §9.2, 06 §2.23): items I (or a team of mine) am assigned to, across the boards I can read,
 * bucketed by each board's date column.
 */
export const WORK_SECTIONS = ['past', 'today', 'this_week', 'next_week', 'later', 'no_date'] as const;
export type WorkSection = (typeof WORK_SECTIONS)[number];

/** Limits (06 §2.23): boards, items, and only items touched in the last 4 months. */
export const MY_WORK_LIMITS = { boards: 50, items: 1000, months: 4 } as const;

/** Which section a date (the item's deadline, 'YYYY-MM-DD') falls in, in the account's calendar. */
export const workSection = (date: string | null, env: DateEnv): WorkSection => {
  if (!date) return 'no_date';
  // The shared relative buckets, folded into My Work's sections.
  const b = relativeDateBucket(date, env);
  if (b === 'today' || b === 'this_week' || b === 'next_week') return b;
  return date < env.today ? 'past' : 'later';
};

/**
 * Per board: hide it, or use another date / status column (column keys); `people_column` = only that column
 * makes an item "mine" on this board (default: any people column naming me or my team).
 */
export const workBoardPrefsSchema = z.object({
  hidden: z.boolean().optional(),
  date_column: z.string().nullable().optional(),
  status_column: z.string().nullable().optional(),
  people_column: z.string().nullable().optional(),
});

export const myWorkSettingsSchema = z
  .object({
    hide_done: z.boolean().default(true),
    group_by: z.enum(['date', 'board']).default('date'),
    /** Subitems assigned to me too (D14: on the sub-board, shown under their parent's board). */
    subitems: z.boolean().default(true),
    boards: z.record(z.string(), workBoardPrefsSchema).default({}),
  })
  .meta({ id: 'MyWorkSettings' });
export type MyWorkSettings = z.infer<typeof myWorkSettingsSchema>;

export const patchMyWorkSettingsSchema = z
  .object({
    hide_done: z.boolean().optional(),
    group_by: z.enum(['date', 'board']).optional(),
    subitems: z.boolean().optional(),
    /** Merged per board; `null` for a board forgets its choices. */
    boards: z.record(z.string(), workBoardPrefsSchema.nullable()).optional(),
  })
  .meta({ id: 'PatchMyWorkSettings' });

const choiceSchema = z.object({ key: z.string(), title: z.string() });

export const workBoardSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** Where its items open: the board itself, or the parent board of a sub-board (D14). */
    open_board_id: z.string(),
    /** A sub-board (its items are subitems). */
    subitems: z.boolean(),
    hidden: z.boolean(),
    /** May edit cells on this board (the row's status / date / people). */
    can_edit: z.boolean(),
    date_column: columnSchema.nullable(),
    status_column: columnSchema.nullable(),
    /** The people column I am assigned in (the first that names me or my team). */
    people_column: columnSchema.nullable(),
    date_choices: z.array(choiceSchema),
    status_choices: z.array(choiceSchema),
    people_choices: z.array(choiceSchema),
    /** My chosen people column (key), or null = any. */
    people_choice: z.string().nullable(),
  })
  .meta({ id: 'WorkBoard' });
export type WorkBoard = z.infer<typeof workBoardSchema>;

export const workItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    board_id: z.string(),
    /** A subitem's parent item. */
    parent: z.object({ id: z.string(), name: z.string() }).nullable(),
    group: z.object({ id: z.string(), title: z.string(), color: z.string() }).nullable(),
    section: z.enum(WORK_SECTIONS),
    /** The deadline used for the section ('YYYY-MM-DD'), or null. */
    date: z.string().nullable(),
    /** Cells of the board's date / status / people columns, by column key. */
    cells: z.record(z.string(), cellSchema),
  })
  .meta({ id: 'WorkItem' });
export type WorkItem = z.infer<typeof workItemSchema>;

export const myWorkSchema = z
  .object({
    today: z.string(),
    sections: z.array(z.object({ key: z.enum(WORK_SECTIONS), items: z.array(workItemSchema) })),
    boards: z.array(workBoardSchema),
    /** More than the limits matched; the oldest were left out. */
    truncated: z.boolean(),
    settings: myWorkSettingsSchema,
  })
  .meta({ id: 'MyWork' });
export type MyWork = z.infer<typeof myWorkSchema>;
