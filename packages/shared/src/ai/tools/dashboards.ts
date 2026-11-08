// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { DASHBOARD_KINDS } from '../../permissions/dashboard';
import { gridRectSchema, WIDGET_TYPES } from '../../widgets';
import { answer, defineTool, id, okAnswer } from './types';

/**
 * Dashboards and their widgets: find a dashboard, read its widgets and the columns its widgets may
 * use, and add / change / remove widgets — through the same services (and permissions) as the dashboard screen.
 */

/** What a model needs to write a widget's settings; the server validates them (422 with the issues). */
const SETTINGS_GUIDE = [
  'A column is named {type, title} as get_dashboard lists it under `columns` (the same column on every source board).',
  'Board-reading widgets (numbers, chart, battery, table, calendar, timeline, workload, time_report) also take',
  'board_ids (some of the dashboard boards; empty = all), source (items | subitems | both) and',
  'filter {operator: and|or, rules: [{column, operator, values}]}.',
  'measure = {fn: count|sum|avg|median|min|max, column (a number column; not for count)}.',
  'numbers: {measure, prefix, suffix}.',
  'chart: {chart_type: bar|stacked_bar|line|pie|donut, x, series (stacked_bar), measure, max_buckets 2-30};',
  'x / series = {kind: column, column, date_unit: day|week|month|quarter|year} | {kind: board} | {kind: group}.',
  'battery: {column (status)}. table: {columns (≤ 8), limit 1-200}. calendar / timeline: {date_column, color_column}.',
  'workload: {people_column, measure, split_column}.',
  'time_report: {group_by: user|board|item|day|column, column, range (this_month, last_30, this_year, custom…),',
  'from, to (YYYY-MM-DD, custom), billable_only}.',
  'board_view: {board_id, view_id, limit}. text: {text}. Omitted settings = the type defaults.',
].join(' ');

const widgetType = z
  .enum(WIDGET_TYPES as [string, ...string[]])
  .describe(
    'Widget type: numbers (a KPI), chart, battery (status split), table, calendar, timeline, workload, ' +
      'time_report, board_view (a board embedded), text (a note), extension (an installed extension widget)',
  );
const widgetSettings = z.record(z.string(), z.unknown()).describe(`The widget settings. ${SETTINGS_GUIDE}`);
const widgetPosition = gridRectSchema.describe(
  'Place on the 12-column grid: x 0-11, y (row), w 1-12, h 1-40; omitted = the first free place',
);
const widgetOut = answer({ id: z.string(), type: z.string(), title: z.string() });

export const listDashboards = defineTool({
  name: 'list_dashboards',
  title: 'List dashboards',
  description: 'The dashboards the user may open, by workspace (or in one workspace). Use get_dashboard for widgets.',
  family: 'dashboards',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ workspace_id: id('Workspace').optional() }),
  output: answer({
    workspaces: z.array(
      answer({
        id: z.string(),
        name: z.string(),
        dashboards: z.array(answer({ id: z.string(), name: z.string(), folder_id: z.string().nullable() })),
      }),
    ),
  }),
});

export const getDashboard = defineTool({
  name: 'get_dashboard',
  title: 'Get a dashboard',
  description:
    'A dashboard: its source boards, its widgets (id, type, title, place, settings), whether the user may edit it, and the columns of its boards that widgets name ({type, title}, with the labels of status columns). Call before adding or changing widgets.',
  family: 'dashboards',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ dashboard_id: id('Dashboard') }),
  output: answer({
    id: z.string(),
    name: z.string(),
    widgets: z.array(widgetOut),
    columns: z.array(answer({ type: z.string(), title: z.string() })),
  }),
});

export const addDashboardWidget = defineTool({
  name: 'add_dashboard_widget',
  title: 'Add a dashboard widget',
  description:
    'Adds a widget to a dashboard (the user must be able to edit it). Read the dashboard first (get_dashboard) for its columns. A widget reads the dashboard source boards; to read another board, add it to the dashboard first in the app.',
  family: 'dashboards',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    dashboard_id: id('Dashboard'),
    type: widgetType,
    title: z.string().trim().max(255).optional(),
    settings: widgetSettings.optional(),
    position: widgetPosition.optional(),
  }),
  output: widgetOut,
});

export const updateDashboardWidget = defineTool({
  name: 'update_dashboard_widget',
  title: 'Change a dashboard widget',
  description:
    "Changes a widget's title, settings (merged into its current settings: send only what changes) or place on the grid.",
  family: 'dashboards',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    widget_id: id('Widget'),
    title: z.string().trim().max(255).optional(),
    settings: widgetSettings.optional(),
    position: widgetPosition.optional(),
  }),
  output: widgetOut,
});

export const removeDashboardWidget = defineTool({
  name: 'remove_dashboard_widget',
  title: 'Remove a dashboard widget',
  description: 'Removes a widget from its dashboard (undo brings it back).',
  family: 'dashboards',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({ widget_id: id('Widget') }),
  output: okAnswer,
});

// --- editing a dashboard itself ----

export const updateDashboard = defineTool({
  name: 'update_dashboard',
  title: 'Change a dashboard',
  description:
    "Changes a dashboard: its name, description, source boards (board_ids — replaces the list; widgets read these), the filter bar every widget follows (search text, person: me / user:<id> / team:<id>), its folder, or who sees it (kind: main = everyone in the workspace, private = only the people invited, shareable = invited people and guests — this one needs a person's approval). Read it first with get_dashboard.",
  family: 'dashboards',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    dashboard_id: id('Dashboard'),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    board_ids: z.array(id('Board')).max(50).optional(),
    filter: z
      .object({ search: z.string().max(200).optional(), person: z.string().max(80).optional() })
      .optional()
      .describe('The filter bar of the whole dashboard; {} clears it'),
    folder_id: id('Folder').nullable().optional().describe('A folder of its workspace; null = the workspace root'),
    kind: z.enum(DASHBOARD_KINDS).optional(),
  }),
  output: answer({ id: z.string(), name: z.string() }),
});

export const setDashboardLayout = defineTool({
  name: 'set_dashboard_layout',
  title: 'Arrange a dashboard',
  description:
    'Moves and resizes several widgets at once (12-column grid). Widgets not listed keep their place; nothing overlaps (later ones move down).',
  family: 'dashboards',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    dashboard_id: id('Dashboard'),
    widgets: z
      .array(z.object({ widget_id: id('Widget'), position: widgetPosition }))
      .min(1)
      .max(60),
  }),
  output: answer({ widgets: z.array(widgetOut) }),
});

export const duplicateDashboardWidget = defineTool({
  name: 'duplicate_dashboard_widget',
  title: 'Duplicate a dashboard widget',
  description: 'Copies a widget (its type and settings) onto the same dashboard, under the others or where given.',
  family: 'dashboards',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    widget_id: id('Widget'),
    title: z.string().trim().max(255).optional(),
    position: widgetPosition.optional(),
  }),
  output: widgetOut,
});

export const duplicateDashboard = defineTool({
  name: 'duplicate_dashboard',
  title: 'Duplicate a dashboard',
  description: 'Copies a dashboard with its widgets and settings, right after it; the user owns the copy.',
  family: 'dashboards',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({ dashboard_id: id('Dashboard'), name: z.string().trim().min(1).max(120).optional() }),
  output: answer({ id: z.string(), name: z.string() }),
});

export const deleteDashboard = defineTool({
  name: 'delete_dashboard',
  title: 'Delete a dashboard',
  description: 'Moves a dashboard to the trash (restorable for 30 days; undo brings it back). Ask the user first.',
  family: 'dashboards',
  scope: 'boards:write',
  risk: 'sensitive',
  input: z.object({ dashboard_id: id('Dashboard') }),
  output: okAnswer,
});
