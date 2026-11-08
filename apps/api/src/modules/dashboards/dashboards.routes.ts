// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  boardWidgetDataRequestSchema,
  boardWidgetDataSchema,
  boardWidgetItemsRequestSchema,
  createDashboardSchema,
  createWidgetSchema,
  dashboardColumnsSchema,
  dashboardDetailSchema,
  dashboardLayoutSchema,
  dashboardMembersSchema,
  dashboardSourceOptionsSchema,
  deletedSchema,
  inviteToDashboardResultSchema,
  inviteToDashboardSchema,
  setDashboardMembersSchema,
  updateDashboardSchema,
  updateWidgetSchema,
  widgetDataRequestSchema,
  widgetDataSchema,
  widgetItemsRequestSchema,
  widgetItemsSchema,
  widgetSchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { boardWidgetData, boardWidgetItems, widgetData, widgetItems } from './dashboards.data';
import * as svc from './dashboards.service';
import { inviteToDashboard } from './dashboards.share';

const common = errors(400, 401, 403, 404, 409, 422);
const widgetParams = idParam.extend({
  widgetId: z.string().openapi({ param: { name: 'widgetId', in: 'path' } }),
});

/** Dashboards (M8 ד4–ד5): CRUD, members, widgets, layout, per-viewer widget data. */
export const dashboardRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();
  const tags = ['dashboards'];

  r.openapi(
    createRoute({
      method: 'post',
      path: '/workspaces/{id}/dashboards',
      tags,
      summary: 'Create a dashboard (members and admins); the creator owns it',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(createDashboardSchema) },
      responses: { 201: json(dashboardDetailSchema, 'Created'), ...common },
    }),
    async (c) => c.json(await svc.createDashboard(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/dashboards/source-options',
      tags,
      summary: 'Every board of the account I may read, from all workspaces (the sources picker)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(dashboardSourceOptionsSchema, 'Boards'), ...common },
    }),
    async (c) => c.json(await svc.sourceOptions(db, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/dashboards/{id}',
      tags,
      summary: 'A dashboard with its widgets, sources and my capabilities',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(dashboardDetailSchema, 'Dashboard'), ...common },
    }),
    async (c) => c.json(await svc.getDashboard(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/dashboards/{id}',
      tags,
      summary: 'Rename, describe, sources and filter (owners); kind, folder / place / workspace',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateDashboardSchema) },
      responses: { 200: json(dashboardDetailSchema, 'Dashboard'), ...common },
    }),
    async (c) => c.json(await svc.updateDashboard(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/dashboards/{id}',
      tags,
      summary: 'Move a dashboard to trash (owners and admins)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(deletedSchema, 'Moved to trash'), ...common },
    }),
    async (c) =>
      c.json({ ok: true as const, event_id: await svc.deleteDashboard(db, actorOf(c), c.req.valid('param').id) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/dashboards/{id}/duplicate',
      tags,
      summary: 'Duplicate a dashboard with its widgets right after it; I own the copy',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: idParam,
        ...jsonBody(z.object({ name: z.string().trim().min(1).max(255).optional() })),
      },
      responses: { 201: json(dashboardDetailSchema, 'The copy'), ...common },
    }),
    async (c) =>
      c.json(await svc.duplicateDashboard(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/dashboards/{id}/members',
      tags,
      summary: 'People and teams invited to the dashboard, with their level',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(dashboardMembersSchema, 'Members'), ...common },
    }),
    async (c) => c.json(await svc.getDashboardMembers(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/dashboards/{id}/members',
      tags,
      summary:
        'Replace the members (owners and admins); guests only on a shareable dashboard, never owners; keeps an owner',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(setDashboardMembersSchema) },
      responses: { 200: json(dashboardMembersSchema, 'Members'), ...common },
    }),
    async (c) =>
      c.json(await svc.setDashboardMembers(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/dashboards/{id}/invite',
      tags,
      summary: 'Share by email: people in the account join now, new people (guests too) get an invitation',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(inviteToDashboardSchema) },
      responses: {
        200: json(inviteToDashboardResultSchema, 'Result'),
        ...errors(400, 401, 403, 404, 409, 422, 429),
      },
    }),
    async (c) => c.json(await inviteToDashboard(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/dashboards/{id}/columns',
      tags,
      summary: "The source boards' columns, groups and views I may see, merged by type + title (widget pickers)",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(dashboardColumnsSchema, 'Columns'), ...common },
    }),
    async (c) => c.json(await svc.dashboardColumns(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/dashboards/{id}/widgets',
      tags,
      summary: 'Add a widget of a registry type (owners)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(createWidgetSchema) },
      responses: { 201: json(widgetSchema, 'Widget'), ...common },
    }),
    async (c) => c.json(await svc.createWidget(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/dashboards/{id}/layout',
      tags,
      summary: "Every widget's place on the grid (after a drag or a resize); overlaps are pushed down",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(dashboardLayoutSchema) },
      responses: { 200: json(z.object({ widgets: z.array(widgetSchema) }), 'Widgets'), ...common },
    }),
    async (c) => c.json(await svc.saveLayout(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/dashboards/{id}/widgets/{widgetId}/data',
      tags,
      summary: "A widget's data as I may see it (each board's own access, item visibility and column rules)",
      middleware: scoped,
      request: { headers: accountHeader, params: widgetParams, ...jsonBody(widgetDataRequestSchema) },
      responses: { 200: json(widgetDataSchema, 'Data'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await widgetData(db, actorOf(c), p.id, p.widgetId, c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/dashboards/{id}/widgets/{widgetId}/items',
      tags,
      summary: 'The items behind a value clicked in a widget (its drill-down), as I may see them, a page at a time',
      middleware: scoped,
      request: { headers: accountHeader, params: widgetParams, ...jsonBody(widgetItemsRequestSchema) },
      responses: { 200: json(widgetItemsSchema, 'Items'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await widgetItems(db, actorOf(c), p.id, p.widgetId, c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/dashboard-widgets/{id}',
      tags,
      summary: "A widget's title and settings (owners)",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateWidgetSchema) },
      responses: { 200: json(widgetSchema, 'Widget'), ...common },
    }),
    async (c) => c.json(await svc.updateWidget(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/dashboard-widgets/{id}',
      tags,
      summary: 'Remove a widget (owners); `restore` undoes it',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(deletedSchema, 'Removed'), ...common },
    }),
    async (c) =>
      c.json({ ok: true as const, event_id: await svc.deleteWidget(db, actorOf(c), c.req.valid('param').id) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/dashboard-widgets/{id}/restore',
      tags,
      summary: 'Bring a removed widget back (undo)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(widgetSchema, 'Widget'), ...common },
    }),
    async (c) => c.json(await svc.restoreWidget(db, actorOf(c), c.req.valid('param').id), 200),
  );
  // ---- a board's Dashboard view (round 15): the same widgets over one board ----
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{id}/widget-data',
      tags,
      summary: "One widget of a board's Dashboard view (its items / subitems, under the view's query when sent)",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(boardWidgetDataRequestSchema) },
      responses: { 200: json(boardWidgetDataSchema, 'Data'), ...common },
    }),
    async (c) => c.json(await boardWidgetData(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{id}/widget-items',
      tags,
      summary: "The items behind a value clicked in a widget of a board's Dashboard view (its drill-down)",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(boardWidgetItemsRequestSchema) },
      responses: { 200: json(widgetItemsSchema, 'Items'), ...common },
    }),
    async (c) => c.json(await boardWidgetItems(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{id}/widget-columns',
      tags,
      summary: "The board's and its sub-board's columns I may see, merged by type + title (widget pickers)",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(dashboardColumnsSchema, 'Columns'), ...common },
    }),
    async (c) => c.json(await svc.boardWidgetColumns(db, actorOf(c), c.req.valid('param').id), 200),
  );
  return r;
};
