// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  approveDevelopmentSchema,
  decideSupportAgentActionSchema,
  opsBoardsSchema,
  startSupportAgentRunSchema,
  supportAgentRunDetailSchema,
  supportAgentConnectionsSchema,
  supportAgentRunSchema,
  supportAgentSettingsDtoSchema,
  updateSupportAgentSettingsSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { currentUser, requestMeta, requireSupportConsole, requireUser } from '../../middleware/auth';
import { errors, idParam, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  approveDevelopment,
  decideSupportAction,
  listSupportRuns,
  startSupportRun,
  stopSupportRun,
  supportRunDetail,
} from './support-agent.service';
import { opsBoards } from './ops-tasks';
import { supportAgentConnections, supportAgentSettingsDto, updateSupportAgentSettings } from './support-agent.settings';

/**
 * The support agent: `/platform/support-agent/*`, for the platform owner and support staff only
 * (404 to everyone else, never with a token) — like the errors hub it works from. Settings: the owner and leads.
 */
export const supportAgentRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();
  const hub = [requireUser(), requireSupportConsole(deps)];
  const common = errors(400, 401, 403, 404, 409, 422);
  const tags = ['platform'];
  const staff = (c: Context<AppEnv>) => ({ user: currentUser(c), role: c.get('supportRole') ?? 'agent' });
  const detail = json(supportAgentRunDetailSchema, 'Investigation');
  const settings = json(supportAgentSettingsDtoSchema, 'Settings');

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support-agent/settings',
      tags,
      summary: 'Support agent: on/off, model, cost caps, GitHub repository (the token only as "set")',
      middleware: hub,
      responses: { 200: settings, ...common },
    }),
    async (c) => c.json(await supportAgentSettingsDto(deps.db, staff(c).role), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/support-agent/settings',
      tags,
      summary: 'Change the support agent settings (the owner and support leads)',
      middleware: hub,
      request: jsonBody(updateSupportAgentSettingsSchema),
      responses: { 200: settings, ...common },
    }),
    async (c) => {
      const s = staff(c);
      return c.json(
        await updateSupportAgentSettings(deps, { userId: s.user.id, role: s.role }, c.req.valid('json')),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support-agent/connections',
      tags,
      summary:
        "The AI connections this person may give the agent (accounts where they are an admin), and whether the help center's AI is set",
      middleware: hub,
      responses: { 200: json(supportAgentConnectionsSchema, 'Connections'), ...common },
    }),
    async (c) => c.json(await supportAgentConnections(deps.db, currentUser(c).id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support-agent/ops-boards',
      tags,
      summary: 'The boards (and groups) an ops-task type may use: in an account where this person is an admin',
      middleware: hub,
      request: { query: z.object({ account_id: z.string().length(26) }) },
      responses: { 200: json(opsBoardsSchema, 'Boards'), ...common },
    }),
    async (c) => c.json(await opsBoards(deps.db, currentUser(c).id, c.req.valid('query').account_id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support-agent/runs',
      tags,
      summary: 'The investigations of an error or a ticket, newest first',
      middleware: hub,
      request: { query: z.object({ error_id: z.string().optional(), ticket_id: z.string().optional() }) },
      responses: { 200: json(z.object({ data: z.array(supportAgentRunSchema) }), 'Investigations'), ...common },
    }),
    async (c) => c.json(await listSupportRuns(deps.db, c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support-agent/runs',
      tags,
      summary: 'Start an investigation of an error or a ticket',
      middleware: hub,
      request: jsonBody(startSupportAgentRunSchema),
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await startSupportRun(deps, staff(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support-agent/runs/{id}',
      tags,
      summary: 'One investigation: status, report, every step and the proposed actions',
      middleware: hub,
      request: { params: idParam },
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await supportRunDetail(deps.db, c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support-agent/runs/{id}/stop',
      tags,
      summary: 'Stop an investigation (before its next step)',
      middleware: hub,
      request: { params: idParam },
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await stopSupportRun(deps.db, staff(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support-agent/runs/{id}/develop',
      tags,
      summary: 'Approve development: the agent writes the fix on its own agent/ branch and opens a DRAFT pull request',
      middleware: hub,
      request: { params: idParam, ...jsonBody(approveDevelopmentSchema) },
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await approveDevelopment(deps, staff(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support-agent/actions/{id}',
      tags,
      summary: "Approve or reject the agent's proposal (resolve / mute the error, a reply to the customer)",
      middleware: hub,
      request: { params: idParam, ...jsonBody(decideSupportAgentActionSchema) },
      responses: { 200: detail, ...common },
    }),
    async (c) =>
      c.json(
        await decideSupportAction(deps, staff(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)),
        200,
      ),
  );

  return r;
};
