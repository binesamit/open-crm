// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { gridRectSchema } from '../widgets/layout';

/**
 * The Dashboard view of a board (round 15): the dashboard widgets (same registry, same settings, same server
 * engine and the same renderers as a workspace dashboard), scoped to this board — its items and / or its subitems
 * — and, when chosen, to the view's own filter, search and person. The widgets live in the view's settings: the
 * view is their container, so its permissions, drafts and "save", duplicate, trash and undo apply as to any view.
 */
/** Widget types a board's dashboard view offers: those that read one board (no embedded board / extension page). */
export const VIEW_WIDGET_TYPES = [
  'numbers',
  'chart',
  'battery',
  'table',
  'calendar',
  'timeline',
  'workload',
  'time_report',
  'text',
] as const;
export type ViewWidgetType = (typeof VIEW_WIDGET_TYPES)[number];
export const VIEW_WIDGETS_MAX = 60;

export const viewWidgetSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(VIEW_WIDGET_TYPES),
  title: z.string().max(255).default(''),
  position: gridRectSchema,
  /** The widget type's settings (`parseWidgetSettings` on save, `readWidgetSettings` on read). */
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type ViewWidget = z.infer<typeof viewWidgetSchema>;

export const viewDashboardSchema = z.object({
  widgets: z.array(viewWidgetSchema).max(VIEW_WIDGETS_MAX).default([]),
  /** The view's toolbar (filter, search, person) narrows every widget; off = the whole board. */
  apply_view_filter: z.boolean().default(true),
});
export type ViewDashboard = z.infer<typeof viewDashboardSchema>;
