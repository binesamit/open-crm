// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * "First steps": a checklist that ticks itself when the person really does each thing — read from
 * what they did in the account (the activity log), never from a visit — with a "show me" tour per step. The steps
 * are data the platform owner edits (owner console → Support → Knowledge → First steps); nothing is fixed in code
 * but the list of things a step can wait for.
 */

/**
 * What a step waits for. `joined` is done from the start; `board_opened` and `view_switched` leave no trace in the
 * activity log, so the app reports them; the rest are read from the person's own events.
 */
export const CHECKLIST_EVENTS = [
  'joined',
  'board_opened',
  'item_created',
  'value_changed',
  'view_switched',
  'teammate_invited',
  'update_written',
  'file_added',
  'items_linked',
  'timer_started',
  'automation_created',
  'dashboard_created',
  'doc_created',
] as const;
export type ChecklistEvent = (typeof CHECKLIST_EVENTS)[number];
/** The ones the app reports (`POST /me/first-steps/mark`). */
export const CLIENT_CHECKLIST_EVENTS = ['board_opened', 'view_switched'] as const;
export type ClientChecklistEvent = (typeof CLIENT_CHECKLIST_EVENTS)[number];

export const checklistStepSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[\w-]+$/),
  event: z.enum(CHECKLIST_EVENTS),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(200).default(''),
  /** The tour "show me" runs (its slug in the help center); none = no button. */
  tour_slug: z.string().trim().max(80).nullable().default(null),
  audience: z.enum(['all', 'admins']).default('all'),
  enabled: z.boolean().default(true),
});
export type ChecklistStep = z.infer<typeof checklistStepSchema>;

/** The platform's checklist settings (inside the help center settings). */
export const checklistSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Opens by itself for this many days after the person joined the account (after that: from the "?" menu). */
  auto_days: z.number().int().min(0).max(365).default(30),
  /** The steps in order; null = the built-in ones, in the reader's language. */
  steps: z.array(checklistStepSchema).max(30).nullable().default(null),
});
export type ChecklistSettings = z.infer<typeof checklistSettingsSchema>;

/** The built-in steps (canvas screen 3): titles come from i18n `checklist.default.<id>.*`. */
export const DEFAULT_CHECKLIST: { id: string; event: ChecklistEvent; audience: 'all' | 'admins' }[] = [
  { id: 'joined', event: 'joined', audience: 'all' },
  { id: 'board', event: 'board_opened', audience: 'all' },
  { id: 'item', event: 'item_created', audience: 'all' },
  { id: 'edit', event: 'value_changed', audience: 'all' },
  { id: 'view', event: 'view_switched', audience: 'all' },
  { id: 'invite', event: 'teammate_invited', audience: 'admins' },
  { id: 'update', event: 'update_written', audience: 'all' },
  { id: 'file', event: 'file_added', audience: 'all' },
  { id: 'link', event: 'items_linked', audience: 'all' },
  { id: 'timer', event: 'timer_started', audience: 'all' },
  { id: 'automation', event: 'automation_created', audience: 'admins' },
];
/** The tour a built-in step's "show me" runs (the help center package names its tours so). */
export const defaultChecklistTourSlug = (id: string) => `first-steps-${id}`;

/** GET /me/first-steps — this person's checklist in this account. */
export const checklistStateSchema = z
  .object({
    /** The checklist exists for this person (the platform's and the account's switches, not a guest). */
    available: z.boolean(),
    /** Opens by itself now (recently joined, not closed, not finished). */
    open: z.boolean(),
    dismissed: z.boolean(),
    /** Shown as a small pill (after its first showing, or since the person folded it) — never over the page. */
    collapsed: z.boolean(),
    /** Every step done (once: the "well done" moment). */
    completed: z.boolean(),
    steps: z.array(
      z.object({
        id: z.string(),
        event: z.enum(CHECKLIST_EVENTS),
        title: z.string(),
        description: z.string(),
        done: z.boolean(),
        /** The "show me" tour, when it exists in the reader's help center. */
        tour_id: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'ChecklistState' });
export type ChecklistState = z.infer<typeof checklistStateSchema>;

export const checklistMarkSchema = z.object({ event: z.enum(CLIENT_CHECKLIST_EVENTS) });
/** Closed for good (or open again), and / or folded into its pill (or unfolded). */
export const checklistDismissSchema = z
  .object({ dismissed: z.boolean().optional(), collapsed: z.boolean().optional() })
  .refine((v) => v.dismissed !== undefined || v.collapsed !== undefined, 'dismissed_or_collapsed');
/** GET /me/first-steps/seen — did the person do this since then (a tour step waiting for an action). */
export const checklistSeenQuerySchema = z.object({
  event: z.enum(CHECKLIST_EVENTS),
  since: z.iso.datetime(),
});
