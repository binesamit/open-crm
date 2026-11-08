// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { DASHBOARD_ACTIONS, DASHBOARD_KINDS, DASHBOARD_LEVELS } from '../permissions/dashboard';
import { dashboardFilterSchema } from '../widgets/common';
import { gridRectSchema } from '../widgets/layout';
import { querySchema } from '../query/filter';
import { VIEW_WIDGET_TYPES } from '../views/dashboard';
import { positionSchema } from './boards';

/**
 * Dashboards (M8 ד4–ד5, D25): a workspace object next to boards and docs, with widgets on a 12-column grid that
 * read several boards. Data is computed per viewer on the server — nobody sees an item their board hides.
 */
export const DASHBOARD_NAME_MAX = 255;
/** Plan §3.4: at most this many source boards per dashboard. */
export const DASHBOARD_BOARDS_MAX = 50;
export const DASHBOARD_WIDGETS_MAX = 60;

export const dashboardKindSchema = z.enum(DASHBOARD_KINDS);
export const dashboardLevelSchema = z.enum(DASHBOARD_LEVELS);

export const dashboardSettingsSchema = z.object({
  /** Source boards (top-level boards, any workspace of the account). */
  board_ids: z.array(z.string()).max(DASHBOARD_BOARDS_MAX).default([]),
  /** The filter bar as saved (every viewer starts with it). */
  filter: dashboardFilterSchema.default({}),
});
export type DashboardSettings = z.infer<typeof dashboardSettingsSchema>;

export const widgetSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    position: gridRectSchema,
    settings: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'DashboardWidget' });
export type Widget = z.infer<typeof widgetSchema>;

/**
 * Before 2026-10-07 `kind` read main / private only (a shareable dashboard read `private`) and the real kind was in
 * `sharing`. `kind` is now the real kind (main / private / shareable) everywhere a dashboard is listed
 * `sharing` stays one release as a deprecated alias of `kind`, then goes.
 */
export const dashboardSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  /** The dashboard's kind: main, private or shareable (guests only on shareable). */
  kind: dashboardKindSchema,
  /** @deprecated the same as `kind`, for clients that read it there (one release); read `kind`. */
  sharing: dashboardKindSchema.meta({ deprecated: true, description: 'Deprecated: the same as `kind`.' }),
  workspace_id: z.string(),
  folder_id: z.string().nullable(),
  position: z.string(),
});

/** A board a dashboard can take as a source: every board of the account I may read, in one list (sources dialog). */
export const dashboardSourceOptionsSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string(), workspace_id: z.string() })),
});
export type DashboardSourceOptions = z.infer<typeof dashboardSourceOptionsSchema>;

export const dashboardDetailSchema = dashboardSummarySchema
  .extend({
    description: z.string(),
    settings: dashboardSettingsSchema,
    /** The source boards with what this viewer may know of them: a board they cannot read is only counted. */
    boards: z.array(z.object({ id: z.string(), name: z.string(), workspace_id: z.string() })),
    hidden_boards: z.number().int(),
    widgets: z.array(widgetSchema),
    capabilities: z.record(z.enum(DASHBOARD_ACTIONS), z.boolean()),
    revision: z.number().int(),
    created_at: z.string(),
    created_by: z.object({ id: z.string(), name: z.string() }).nullable(),
    updated_at: z.string(),
  })
  .meta({ id: 'Dashboard' });
export type DashboardDetail = z.infer<typeof dashboardDetailSchema>;

export const createDashboardSchema = z.object({
  name: z.string().trim().min(1).max(DASHBOARD_NAME_MAX).optional(),
  folder_id: z.string().nullable().optional(),
  kind: dashboardKindSchema.default('main'),
  board_ids: z.array(z.string()).max(DASHBOARD_BOARDS_MAX).optional(),
});

export const updateDashboardSchema = z.object({
  name: z.string().trim().min(1).max(DASHBOARD_NAME_MAX).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().max(16).nullable().optional(),
  kind: dashboardKindSchema.optional(),
  folder_id: z.string().nullable().optional(),
  workspace_id: z.string().optional(),
  position: positionSchema,
  settings: z
    .object({
      board_ids: z.array(z.string()).max(DASHBOARD_BOARDS_MAX).optional(),
      filter: dashboardFilterSchema.optional(),
    })
    .optional(),
});

export const createWidgetSchema = z.object({
  type: z.string().min(1).max(40),
  title: z.string().trim().max(255).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  position: gridRectSchema.optional(),
});
export const updateWidgetSchema = z.object({
  title: z.string().trim().max(255).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
/** PUT /dashboards/:id/layout — every widget's place (after a drag or a resize). */
export const dashboardLayoutSchema = z.object({
  widgets: z.array(z.object({ id: z.string(), position: gridRectSchema })).max(DASHBOARD_WIDGETS_MAX),
});

/** POST …/data — the filter bar as the viewer has it now (unsaved). */
export const widgetDataRequestSchema = z.object({ filter: dashboardFilterSchema.optional() });
export const widgetDataSchema = z
  .object({
    widget_id: z.string(),
    type: z.string(),
    /** Sources this viewer read; boards they may not read are only counted. */
    boards: z.array(z.object({ id: z.string(), name: z.string() })),
    hidden_boards: z.number().int(),
    /** More items matched than a widget reads (5,000 per board); the numbers cover the first ones. */
    truncated: z.boolean(),
    data: z.unknown(),
  })
  .meta({ id: 'WidgetData' });
export type WidgetData<D = unknown> = Omit<z.infer<typeof widgetDataSchema>, 'data'> & { data: D };

/**
 * Prod — the items behind a value a viewer clicked in a widget (its drill-down): `x` / `series` = a chart's
 * bucket and series keys, `not_x` = the buckets folded into "other" (every key shown), `segment` = a battery label's
 * key, `person` = a workload row (a user id or the empty bucket). Nothing picked = every item the widget reads.
 */
export const WIDGET_ITEMS_PAGE = 50;
export const widgetPickSchema = z.object({
  x: z.string().max(300).optional(),
  not_x: z.array(z.string().max(300)).max(200).optional(),
  series: z.string().max(300).optional(),
  segment: z.string().max(300).optional(),
  person: z.string().max(64).optional(),
});
export type WidgetPick = z.infer<typeof widgetPickSchema>;
export const widgetItemsRequestSchema = z.object({
  filter: dashboardFilterSchema.optional(),
  pick: widgetPickSchema.default({}),
  /** `next_cursor` of the previous page. */
  cursor: z.string().max(16).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export const widgetItemSchema = z.object({
  id: z.string(),
  /** The source board the item opens over (a subitem: its top board). */
  board_id: z.string(),
  board_name: z.string(),
  name: z.string(),
  /** A subitem's direct parent. */
  parent_name: z.string().nullable(),
});
export const widgetItemsSchema = z
  .object({ data: z.array(widgetItemSchema), total: z.number().int(), next_cursor: z.string().nullable() })
  .meta({ id: 'WidgetItems' });
export type WidgetItems = z.infer<typeof widgetItemsSchema>;

/**
 * POST /boards/:id/widget-data (round 15) — one widget of a board's Dashboard view, as the view has it now (a
 * draft too, like the Chart view's request): its type and settings, and the view's query when it narrows widgets.
 */
export const boardWidgetDataRequestSchema = z.object({
  widget: z.object({
    type: z.enum(VIEW_WIDGET_TYPES),
    settings: z.record(z.string(), z.unknown()).default({}),
  }),
  /** The view's filter, search and person (its toolbar); none = the whole board. */
  query: querySchema.optional(),
});
export const boardWidgetDataSchema = widgetDataSchema.omit({ widget_id: true }).meta({ id: 'BoardWidgetData' });
/** POST /boards/:id/widget-items — the drill-down of a board Dashboard view's widget. */
export const boardWidgetItemsRequestSchema = boardWidgetDataRequestSchema.extend({
  pick: widgetPickSchema.default({}),
  cursor: z.string().max(16).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

/** GET /dashboards/:id/columns — the source boards' columns, merged by type + title (for the widget pickers). */
export const dashboardColumnsSchema = z.object({
  boards: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** Round 15: this entry is the sub-board (subitems) of that source board; its name is the board's. */
      subitems_of: z.string().nullable().optional(),
      columns: z.array(z.object({ id: z.string(), type: z.string(), title: z.string() })),
      groups: z.array(z.object({ id: z.string(), title: z.string() })),
      views: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
  columns: z.array(
    z.object({
      type: z.string(),
      title: z.string(),
      /** board id → key, on the boards that have it. */
      keys: z.record(z.string(), z.string()),
      /** Label texts and colours (status / dropdown), merged. */
      labels: z.array(z.object({ label: z.string(), color: z.string() })),
    }),
  ),
});
export type DashboardColumns = z.infer<typeof dashboardColumnsSchema>;

export const dashboardMemberSchema = z.object({
  type: z.enum(['user', 'team']),
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  level: dashboardLevelSchema,
});
export const dashboardMembersSchema = z
  .object({ data: z.array(dashboardMemberSchema) })
  .meta({ id: 'DashboardMembers' });
export type DashboardMembers = z.infer<typeof dashboardMembersSchema>;
export const setDashboardMembersSchema = z.object({
  members: z.array(z.object({ type: z.enum(['user', 'team']), id: z.string(), level: dashboardLevelSchema })).max(500),
});

/**
 * POST /dashboards/:id/invite — share a dashboard by email, like a board's / doc's invite: people already in the
 * account join it at once at `level`; new people get an account invitation that adds them when they accept. A guest
 * only on a shareable dashboard, and never as its owner (an `owner` invitation makes a guest an editor).
 */
export const inviteToDashboardSchema = z.object({
  emails: z.array(z.email().toLowerCase()).min(1).max(50),
  role: z.enum(['member', 'guest']).default('guest'),
  level: dashboardLevelSchema.default('viewer'),
  message: z.string().max(1000).optional(),
  /** false = no email to new people, only their invitation links to copy; default true. */
  send_email: z.boolean().optional(),
});
export const inviteToDashboardResultSchema = z
  .object({
    /** `url`: the new invitation's link, to copy and send another way. */
    invited: z.array(z.object({ email: z.string(), url: z.string().optional() })),
    added: z.array(z.object({ email: z.string(), user_id: z.string() })),
    errors: z.array(z.object({ email: z.string(), code: z.string() })),
  })
  .meta({ id: 'InviteToDashboardResult' });
export type InviteToDashboardResult = z.infer<typeof inviteToDashboardResultSchema>;
