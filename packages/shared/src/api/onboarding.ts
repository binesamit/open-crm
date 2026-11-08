// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * "How to start?": after a self sign-up the account's admin picks a full template (a starter kit the
 * platform owner shows in the gallery) or describes the business and lets AI propose a structure (a blueprint),
 * previews it and builds it in one go. Everything here is a setting of the owner console — no kit, chip or text is
 * fixed in code.
 */

/** The small drawing on a gallery card (kits have no uploaded picture: one of these, in the kit's own colour). */
export const KIT_ILLUSTRATIONS = ['table', 'chart', 'kanban', 'timeline', 'calendar', 'blank'] as const;
export type KitIllustration = (typeof KIT_ILLUSTRATIONS)[number];

/** A starter kit's card on the start screen (owner console → Kits). */
export const kitGallerySchema = z.object({
  /** Shown on the start screen. */
  show: z.boolean().default(false),
  recommended: z.boolean().default(false),
  /** A short group name ("Sales", "Projects"…); the gallery groups by it. */
  category: z.string().trim().max(40).nullable().default(null),
  /** Lower first. */
  order: z.number().int().min(0).max(999).default(100),
  illustration: z.enum(KIT_ILLUSTRATIONS).default('table'),
});
export type KitGallery = z.infer<typeof kitGallerySchema>;

/** The start screen's settings (owner console → Sign-up → "How to start"). */
export const onboardingSettingsSchema = z.object({
  /** New self sign-up accounts open with the start screen (their kit then waits for the admin's choice). */
  enabled: z.boolean().default(true),
  /** "Build with AI" on the start screen (on the platform's AI connection: Support → Knowledge → AI). */
  ai: z.boolean().default(true),
  /** What the platform pays for one account's AI set-up, in USD, in total. */
  ai_cap_usd: z.number().min(0).max(20).default(0.5),
  /** Quick picks under "What do you want to manage?"; empty = the built-in ones in the reader's language. */
  chips: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
});
export type OnboardingSettings = z.infer<typeof onboardingSettingsSchema>;

export const ONBOARDING_STATUSES = ['none', 'pending', 'done'] as const;
/** An account's own state (account settings): `pending` = its admin still sees the start screen. */
export const accountOnboardingSchema = z.object({
  status: z.enum(ONBOARDING_STATUSES).default('none'),
  /** What it chose: a kit key, `ai` or `skip`. */
  choice: z.string().max(64).nullable().default(null),
  done_at: z.string().nullable().default(null),
  /** Phase B: rows a kit or a blueprint brought as samples ("delete the sample data" takes them away). */
  sample_item_ids: z.array(z.string()).max(5000).default([]),
});

// ---- the blueprint: what the AI proposes, the person previews and the server builds ----

/** Column types a blueprint may use (simple ones a model gets right; anything else is added later in the app). */
export const BLUEPRINT_COLUMN_TYPES = [
  'text',
  'long_text',
  'numbers',
  'status',
  'dropdown',
  'date',
  'timeline',
  'people',
  'email',
  'phone',
  'link',
  'checkbox',
  'rating',
  'file',
  'board_relation',
] as const;
export type BlueprintColumnType = (typeof BLUEPRINT_COLUMN_TYPES)[number];

const name = (max: number) => z.string().trim().min(1).max(max);
const boardKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,30}$/)
  .describe('Short id of the board inside the blueprint (a-z, 0-9, _), e.g. "clients"');

export const blueprintColumnSchema = z.object({
  title: name(60),
  type: z.enum(BLUEPRINT_COLUMN_TYPES),
  /** status / dropdown: the labels, in order (a status's last label = done). */
  labels: z.array(name(30)).max(12).optional(),
  /** board_relation: the key of the blueprint board it links to. */
  link_to: boardKey.optional(),
});

export const blueprintBoardSchema = z.object({
  key: boardKey,
  name: name(80),
  /** One of the blueprint's folders. */
  folder: name(80).optional(),
  /** What one row is called ("client", "task"). */
  item_name: name(30).optional(),
  groups: z
    .array(z.object({ title: name(60) }))
    .min(1)
    .max(8),
  columns: z.array(blueprintColumnSchema).max(20),
  /** Sample rows: values by column title, as text ("Done", "2026-11-03", "1200"). */
  items: z
    .array(
      z.object({
        name: name(120),
        group: name(60).optional(),
        values: z.record(z.string(), z.string().max(200)).optional(),
      }),
    )
    .max(10)
    .optional(),
  /** More views of the board (phase B): a kanban by a status, a calendar / timeline by a date column. */
  views: z
    .array(
      z.object({
        name: name(60),
        type: z.enum(['kanban', 'calendar', 'timeline', 'cards']),
        /** kanban → a status column's title; calendar / timeline → a date or timeline column's title. */
        column: name(60).optional(),
      }),
    )
    .max(4)
    .optional(),
});

/**
 * A simple automation (phase B), made switched off — the person reviews and switches it on. Columns by title on its
 * board; "who" = the board's owners or a people column's title.
 */
export const blueprintAutomationSchema = z.object({
  board: boardKey,
  title: name(120),
  when: z.discriminatedUnion('type', [
    z.object({ type: z.literal('item_created') }),
    z.object({ type: z.literal('status_changed'), column: name(60), to: name(30) }),
    z.object({ type: z.literal('date_arrives'), column: name(60) }),
  ]),
  then: z.discriminatedUnion('type', [
    z.object({ type: z.literal('notify'), who: name(60).describe('"owners", or a people column title') }),
    z.object({ type: z.literal('set_status'), column: name(60), label: name(30) }),
    z.object({ type: z.literal('assign_creator'), column: name(60).describe('a people column title') }),
  ]),
});

export const BLUEPRINT_WIDGET_TYPES = [
  'numbers',
  'chart',
  'battery',
  'table',
  'calendar',
  'timeline',
  'workload',
] as const;

export const blueprintWidgetSchema = z.object({
  type: z.enum(BLUEPRINT_WIDGET_TYPES),
  title: name(80),
  /** The board it reads (blueprint key); none = every board of the dashboard. */
  board: boardKey.optional(),
  /** The column it is about (title on that board): numbers → a number column to sum (none = count);
   *  chart / battery → a status or dropdown column; calendar / timeline → a date or timeline column;
   *  workload → a people column; table → ignored. */
  column: name(60).optional(),
  chart_type: z.enum(['bar', 'pie', 'donut', 'line']).optional(),
});

export const blueprintSchema = z.object({
  workspace_name: name(80),
  folders: z.array(name(80)).max(10).optional(),
  boards: z.array(blueprintBoardSchema).min(1).max(12),
  dashboard: z.object({ name: name(80), widgets: z.array(blueprintWidgetSchema).max(8) }).optional(),
  automations: z.array(blueprintAutomationSchema).max(10).optional(),
  /** Short docs (Markdown): how the team works, a checklist, a script. */
  docs: z
    .array(z.object({ name: name(120), folder: name(80).optional(), markdown: z.string().max(6000) }))
    .max(3)
    .optional(),
});
export type Blueprint = z.infer<typeof blueprintSchema>;

// ---- API ----

/** One gallery card. */
export const onboardingKitSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  gallery: kitGallerySchema,
  /** How many boards it makes (the plan check). */
  boards: z.number().int(),
  /** Already installed in this account (offered again only as a new workspace is not possible). */
  installed: z.boolean(),
});

/** GET /onboarding — what the start screen shows to this person. */
export const onboardingStateSchema = z
  .object({
    /** Open it by itself (the account's admin, right after sign-up). */
    pending: z.boolean(),
    /** The person may build here (account admin). */
    can_build: z.boolean(),
    kits: z.array(onboardingKitSchema),
    ai: z.object({ available: z.boolean(), chips: z.array(z.string()) }),
    /** Boards the plan still allows; null = no limit. */
    boards_left: z.number().int().nullable(),
    /** Phase B: sample rows a kit / blueprint brought that are still there, and on which boards (admins). */
    sample: z.object({ items: z.number().int(), board_ids: z.array(z.string()) }),
  })
  .meta({ id: 'OnboardingState' });
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const onboardingKitInstallSchema = z.object({
  kit: z.string().max(64),
  /** Phase B: the kit's sample rows (its templates' items) — off = the boards come empty. */
  sample_data: z.boolean().default(true),
});

/** POST /onboarding/ai — one turn: the conversation so far (the client keeps it), newest last. */
export const onboardingAiTurnSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1).max(2000) }))
    .min(1)
    .max(16),
  /** The blueprint on screen, when the person asks to change it. */
  blueprint: blueprintSchema.optional(),
});
export const onboardingAiReplySchema = z.object({
  /** What the assistant says (a question, or a line about the proposal). */
  text: z.string(),
  /** A (new or changed) proposal, when it made one. */
  blueprint: blueprintSchema.nullable(),
});

export const onboardingBuildSchema = z.object({
  blueprint: blueprintSchema,
  /** Board keys left out in the preview. */
  skip_boards: z.array(z.string().max(31)).max(12).default([]),
  sample_data: z.boolean().default(true),
});
export const onboardingBuiltSchema = z.object({
  workspace_id: z.string(),
  board_ids: z.array(z.string()),
  dashboard_id: z.string().nullable(),
  /** Phase B: the docs and the (switched-off) automations it made. */
  doc_ids: z.array(z.string()).default([]),
  automation_ids: z.array(z.string()).default([]),
  /** Parts that could not be made (a widget whose column is missing…), as codes. */
  issues: z.array(z.string()),
});
