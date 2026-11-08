// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * What an account admin sets in the extension's settings page (one sync per installation): the board, where an
 * item's time lives (the core calendar's two sources), the people column, the target calendars, the template a new
 * Google event becomes an item through, and the recurring-events switch.
 */
export const TEMPLATE_VARS = [
  'title',
  'description',
  'location',
  'meet_link',
  'organizer',
  'attendees',
  'calendar',
] as const;
export type TemplateVar = (typeof TEMPLATE_VARS)[number];

const DIRECTION_ON = { create: true, update: true, delete: true };
const direction = z
  .object({ create: z.boolean().default(true), update: z.boolean().default(true), delete: z.boolean().default(true) })
  .default({ ...DIRECTION_ON });

export const syncConfigSchema = z.object({
  board_id: z.string().min(1).max(64),
  /** `timeline` = a timeline column with hours; `date_hours` = a date column plus start / end hour columns. */
  time_source: z.enum(['timeline', 'date_hours']),
  date_column_id: z.string().min(1).max(64),
  start_column_id: z.string().max(64).nullable().default(null),
  end_column_id: z.string().max(64).nullable().default(null),
  /** Minutes an item with a start and no end lasts. */
  default_duration: z.number().int().min(5).max(1440).default(60),
  /** Items where a member appears go to that member's own calendar. */
  people_column_id: z.string().max(64).nullable().default(null),
  target: z.enum(['personal', 'shared', 'both']).default('personal'),
  /**
   * An item with nobody in its people column (personal calendars): `creator` = the calendar of the member who
   * created it (when they connected), `skip` = no personal calendar.
   */
  no_people: z.enum(['skip', 'creator']).default('creator'),
  /** The shared calendar: one of the connecting admin's calendars. */
  shared: z
    .object({ user_id: z.string().min(1), calendar_id: z.string().min(1).max(300), calendar_name: z.string().max(300) })
    .nullable()
    .default(null),
  /** The account's zone: timeline times and hour columns are wall-clock in it. */
  timezone: z.string().min(1).max(64).default('Asia/Jerusalem'),
  /** New events that ended more than this many days ago are not imported. */
  past_days: z.number().int().min(0).max(365).default(30),
  /**
   * The most a member may let into the board from their own calendar (each member picks up to this on "My
   * calendar"): `none` = only meetings made on the board sync; `new` = also meetings made in the calendar from the
   * moment they chose it; `existing` = also the ones already there (up to `past_days` back).
   */
  member_import: z.enum(['none', 'new', 'existing']).default('existing'),
  recurring: z
    .object({ enabled: z.boolean().default(false), days: z.number().int().min(1).max(366).default(90) })
    .default({ enabled: false, days: 90 }),
  /** What flows each way; each switch on its own. */
  directions: z
    .object({
      to_google: direction,
      to_bines: direction,
    })
    .default({ to_google: { ...DIRECTION_ON }, to_bines: { ...DIRECTION_ON } }),
  /** An item deleted on the board (or no longer for that calendar): delete the event, cancel it (the guests are told), or only unlink. */
  on_bines_delete: z.enum(['delete', 'cancel', 'unlink']).default('delete'),
  /** An event deleted / cancelled in the calendar: the item to the trash (soft delete), archived, a status label, or only unlink. */
  on_google_delete: z.enum(['trash', 'archive', 'status', 'unlink']).default('trash'),
  /** For `on_google_delete: 'status'`: the status column and the label it gets. */
  delete_status: z
    .object({ column_id: z.string().min(1).max(64), label: z.string().min(1).max(120) })
    .nullable()
    .default(null),
  /** Invitations: the people column's members (by email) and an email column's guests become attendees. */
  attendees: z
    .object({
      enabled: z.boolean().default(false),
      /** An email / text column with outside guests (several separated by commas). */
      email_column_id: z.string().max(64).nullable().default(null),
      /** Google `sendUpdates`: who is told about invitations and changes. */
      send_updates: z.enum(['all', 'externalOnly', 'none']).default('none'),
    })
    .default({ enabled: false, email_column_id: null, send_updates: 'none' }),
  /** The attendees' answers back on the board. */
  rsvp: z
    .object({
      /** A status column; null = off. */
      column_id: z.string().max(64).nullable().default(null),
      /** The label each aggregate answer sets (empty = leave the column as it is). */
      labels: z
        .object({
          accepted: z.string().max(120).default(''),
          declined: z.string().max(120).default(''),
          tentative: z.string().max(120).default(''),
          pending: z.string().max(120).default(''),
        })
        .default({ accepted: '', declined: '', tentative: '', pending: '' }),
      /** Each person's changed answer as an update on the item. */
      comments: z.boolean().default(false),
    })
    .default({
      column_id: null,
      labels: { accepted: '', declined: '', tentative: '', pending: '' },
      comments: false,
    }),
  /** A Google Meet link on events made from the board (written back to the `{{meet_link}}` column). */
  create_meet: z.boolean().default(false),
  /** Reminders on events made from the board (minutes before; null = none of that kind). */
  reminders: z
    .object({
      enabled: z.boolean().default(false),
      popup_minutes: z.number().int().min(0).max(40320).nullable().default(10),
      email_minutes: z.number().int().min(0).max(40320).nullable().default(null),
    })
    .default({ enabled: false, popup_minutes: 10, email_minutes: null }),
  template: z
    .object({
      group_id: z.string().max(64).nullable().default(null),
      /** The new item's name, e.g. `{{title}}`. */
      name: z.string().max(500).default('{{title}}'),
      /** Column values: `{ column_id, template }`, e.g. `{ column_id: 'text_notes', template: '{{description}}' }`. */
      fields: z
        .array(z.object({ column_id: z.string().min(1).max(64), template: z.string().max(2000) }))
        .max(20)
        .default([]),
    })
    .default({ group_id: null, name: '{{title}}', fields: [] }),
});
export type SyncConfig = z.infer<typeof syncConfigSchema>;

/**
 * A saved configuration with the settings added since it was saved filled in (their defaults): a config stored by
 * an older version is read as the admin page shows it. One that no longer parses is kept as it is.
 */
export const withDefaults = (cfg: SyncConfig | null): SyncConfig | null => {
  if (!cfg) return cfg;
  const r = syncConfigSchema.safeParse(cfg);
  return r.success ? r.data : cfg;
};
