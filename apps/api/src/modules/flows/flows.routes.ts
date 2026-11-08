// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  aiFlowDraftRequestSchema,
  createFlowConnectionSchema,
  createFlowFromDraftSchema,
  FLOW_PLATFORMS,
  flowConnectionSchema,
  flowDraftAnswerSchema,
  flowLimitSchema,
  flowListAnswerSchema,
  flowRefreshQuerySchema,
  flowRunSchema,
  flowRunsQuerySchema,
  flowSchema,
  flowStatsAnswerSchema,
  flowStatsRequestSchema,
  setFlowActiveSchema,
  updateFlowConnectionSchema,
} from '@bines/shared';
import { requestMeta, requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './flows.service';

const tags = ['flows'];
const common = errors(400, 401, 403, 404, 409, 422, 429);

const flowParams = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
  flowId: z
    .string()
    .max(64)
    .openapi({ param: { name: 'flowId', in: 'path' } }),
});
const runParams = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
  runId: z
    .string()
    .max(64)
    .openapi({ param: { name: 'runId', in: 'path' } }),
});
const runFlowQuery = z.object({ flow_id: z.string().max(64).optional() });

/**
 * "זרימות": connections to external automation platforms and their flows. A person's session only
 * (lib/scopes — an API token never reaches platform keys); admins manage, members view a connection opened to them.
 * The AI reaches the same service through the `flows_*` tools.
 */
export const flowRoutes = (deps: AppDeps) => {
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/flow-connections',
      tags,
      summary: 'Connections to external automation platforms (admins: all; members: those opened to them)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: {
        200: json(
          z.object({ data: z.array(flowConnectionSchema), platforms: z.array(z.enum(FLOW_PLATFORMS)) }),
          'Connections',
        ),
        ...common,
      },
    }),
    async (c) => c.json(await svc.listFlowConnections(deps, actorOf(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/flow-connections',
      tags,
      summary: 'Admins: connect a platform (its key is sealed and never shown again) and test it',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(createFlowConnectionSchema) },
      responses: { 201: json(flowConnectionSchema, 'Connected'), ...common },
    }),
    async (c) => c.json(await svc.createFlowConnection(deps, actorOf(c), c.req.valid('json'), requestMeta(c)), 201),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/flow-connections/{id}',
      tags,
      summary: 'Admins: rename, new address / key, settings, on / off',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateFlowConnectionSchema) },
      responses: { 200: json(flowConnectionSchema, 'Updated'), ...common },
    }),
    async (c) =>
      c.json(
        await svc.updateFlowConnection(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/flow-connections/{id}',
      tags,
      summary: 'Admins: remove a connection (its key is erased; the flows stay on the platform)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Removed'), ...common },
    }),
    async (c) => c.json(await svc.deleteFlowConnection(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/flow-connections/{id}/test',
      tags,
      summary: 'Admins: test the connection now',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(flowConnectionSchema, 'Tested'), ...common },
    }),
    async (c) => c.json(await svc.testFlowConnection(deps, actorOf(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/flow-connections/{id}/flows',
      tags,
      summary:
        'The flows on the platform: status, last run, failures in the last 7 days (kept a while; `refresh=1` asks again)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, query: flowRefreshQuerySchema },
      responses: { 200: json(flowListAnswerSchema, 'Flows'), ...common },
    }),
    async (c) =>
      c.json(
        await svc.listFlows(deps, actorOf(c), c.req.valid('param').id, { refresh: c.req.valid('query').refresh }),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/flow-connections/{id}/flows/stats',
      tags,
      summary:
        "Some flows' last run and failures of the week (platforms that need calls per flow): paced, kept; `pending` + `limited` when not now",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(flowStatsRequestSchema) },
      responses: { 200: json(flowStatsAnswerSchema, 'Stats'), ...common },
    }),
    async (c) => c.json(await svc.flowStatsOf(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/flow-connections/{id}/flows',
      tags,
      summary: 'Admins: create a flow from an approved draft — always switched off',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(createFlowFromDraftSchema) },
      responses: { 201: json(flowSchema, 'Created (off)'), ...common },
    }),
    async (c) =>
      c.json(
        await svc.createFlowFromDraft(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json').draft, 'person'),
        201,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/flow-connections/{id}/drafts',
      tags,
      summary: "Admins: the AI turns a request in words into a draft (the account's AI connection; nothing is created)",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(aiFlowDraftRequestSchema) },
      responses: { 200: json(flowDraftAnswerSchema, 'Draft'), ...common },
    }),
    async (c) =>
      c.json(await svc.aiDraftFlow(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json').request), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/flow-connections/{id}/flows/{flowId}',
      tags,
      summary: 'One flow',
      middleware: scoped,
      request: { headers: accountHeader, params: flowParams },
      responses: { 200: json(flowSchema, 'Flow'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.getFlow(deps, actorOf(c), p.id, p.flowId), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/flow-connections/{id}/flows/{flowId}/active',
      tags,
      summary: 'Admins: switch a flow on or off (platforms that allow it)',
      middleware: scoped,
      request: { headers: accountHeader, params: flowParams, ...jsonBody(setFlowActiveSchema) },
      responses: { 200: json(flowSchema, 'Switched'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.setFlowActive(deps, actorOf(c), p.id, p.flowId, c.req.valid('json').active), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/flow-connections/{id}/runs',
      tags,
      summary: 'Recent runs (of one flow, or of all), newest first; failed ones with their error',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, query: flowRunsQuerySchema },
      responses: {
        200: json(
          z.object({
            data: z.array(flowRunSchema),
            /**
             * One flow's runs could not be read (the platform refused that flow — not the connection): `data` is empty,
             * `warning` = `flow_runs_unavailable` and `warning_detail` = the platform's own reason.
             */
            warning: z.string().optional(),
            warning_detail: z.string().optional(),
            /** The platform cannot be asked now (`warning` = `flow_platform_limited`): `data` is the last answer kept. */
            limited: flowLimitSchema.nullable().optional(),
            fetched_at: z.string().nullable().optional(),
          }),
          'Runs',
        ),
        ...common,
      },
    }),
    async (c) => c.json(await svc.listFlowRuns(deps, actorOf(c), c.req.valid('param').id, c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/flow-connections/{id}/runs/{runId}',
      tags,
      summary: 'One run with its error details',
      middleware: scoped,
      request: { headers: accountHeader, params: runParams, query: runFlowQuery },
      responses: { 200: json(flowRunSchema, 'Run'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.getFlowRun(deps, actorOf(c), p.id, p.runId, c.req.valid('query').flow_id), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/flow-connections/{id}/runs/{runId}/retry',
      tags,
      summary: 'Admins: run a failed run again (platforms that allow it)',
      middleware: scoped,
      request: { headers: accountHeader, params: runParams, query: runFlowQuery },
      responses: { 200: json(z.object({ run_id: z.string().nullable() }), 'Started'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.retryFlowRun(deps, actorOf(c), p.id, p.runId, c.req.valid('query').flow_id), 200);
    },
  );

  return r;
};
