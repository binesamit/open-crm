// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  agentApprovalSchema,
  agentRunDetailSchema,
  agentRunSchema,
  agentSchema,
  agentTemplateSchema,
  AGENT_RUN_STATUSES,
  createAgentSchema,
  decideApprovalSchema,
  startAgentRunSchema,
  updateAgentSchema,
} from '@bines/shared';
import { requestMeta, requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, idParam, json, jsonBody, okSchema, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  agentConnections,
  createAgent,
  decideAgentWebSearch,
  deleteAgent,
  getAgent,
  listAgents,
  listAgentTemplates,
  seedAgentTemplates,
  updateAgent,
} from './agents.service';
import { cancelRun, decideApproval, getRun, listApprovals, listRuns, startRun, undoRun } from './runs.service';
import { registerAgentExtraRoutes } from './agents-extra.routes';

/**
 * Agents (the planning notes "AGENTS-MCP" מ6–מ7): CRUD, starter templates, "run now", runs + transcript, approvals, cancel
 * and undo a run. The services decide who may (admins; members when the account allows, for their own agents).
 */
export const agentRoutes = (deps: AppDeps) => {
  const middleware = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();
  const runList = z.object({ data: z.array(agentRunSchema), next_cursor: z.string().nullable() });

  r.openapi(
    createRoute({
      method: 'get',
      path: '/agents',
      tags: ['agents'],
      summary: 'Agents I manage (admins: all) and whether I may create one',
      middleware,
      request: { headers: accountHeader },
      responses: {
        200: json(
          z.object({
            data: z.array(agentSchema),
            can_create: z.boolean(),
            /** A new agent's "mention" trigger starts with this (the account's AI settings). */
            new_agent_mention: z.boolean().optional(),
          }),
          'Agents',
        ),
        ...COMMON_ERRORS,
      },
    }),
    async (c) => c.json(await listAgents(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/agents',
      tags: ['agents'],
      summary: 'Create an agent (its own service user; boards checked against my rights)',
      middleware,
      request: { headers: accountHeader, ...jsonBody(createAgentSchema) },
      responses: { 201: json(agentSchema, 'Created'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await createAgent(deps, actorOf(c), c.req.valid('json'), requestMeta(c)), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/agents/connections',
      tags: ['agents'],
      summary: 'AI connections an agent may use (names only — for whoever may create agents)',
      middleware,
      request: { headers: accountHeader },
      responses: {
        200: json(
          z.object({
            data: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                provider: z.string(),
                default_model: z.string().nullable(),
              }),
            ),
          }),
          'Connections',
        ),
        ...COMMON_ERRORS,
      },
    }),
    async (c) => c.json(await agentConnections(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/agents/templates',
      tags: ['agents'],
      summary: 'Starter agent templates (data in seed/agents) and which are already added',
      middleware,
      request: { headers: accountHeader },
      responses: {
        200: json(z.object({ data: z.array(agentTemplateSchema.extend({ added: z.boolean() })) }), 'Templates'),
        ...COMMON_ERRORS,
      },
    }),
    async (c) => c.json(await listAgentTemplates(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/agents/templates/seed',
      tags: ['agents'],
      summary: 'Add starter agents from the templates (inactive, learner mode, no boards)',
      middleware,
      request: {
        headers: accountHeader,
        ...jsonBody(z.object({ connection_id: z.string().min(1), keys: z.array(z.string()).max(50).optional() })),
      },
      responses: { 201: json(z.object({ data: z.array(agentSchema) }), 'Added'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await seedAgentTemplates(deps, actorOf(c), c.req.valid('json'), requestMeta(c)), 201),
  );
  // מ8–מ9: directory, automations of an agent, knowledge (before /agents/{id}).
  registerAgentExtraRoutes(r, deps, middleware);
  r.openapi(
    createRoute({
      method: 'get',
      path: '/agents/approvals',
      tags: ['agents'],
      summary: 'Approval requests of the agents I manage (the approvals inbox)',
      middleware,
      request: {
        headers: accountHeader,
        query: z.object({
          status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: { 200: json(z.object({ data: z.array(agentApprovalSchema) }), 'Approvals'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await listApprovals(deps, actorOf(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/agents/approvals/{id}',
      tags: ['agents'],
      summary: 'Approve or reject a waiting step; the run resumes from where it stopped',
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(decideApprovalSchema) },
      responses: { 200: json(agentApprovalSchema, 'Decided'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await decideApproval(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/agents/runs',
      tags: ['agents'],
      summary: 'Runs of the agents I manage, newest first',
      middleware,
      request: {
        headers: accountHeader,
        query: z.object({
          agent_id: z.string().optional(),
          status: z.enum(AGENT_RUN_STATUSES).optional(),
          before: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
      },
      responses: { 200: json(runList, 'Runs'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await listRuns(deps, actorOf(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/agents/runs/{id}',
      tags: ['agents'],
      summary: 'A run with every step ("what the agent did") and its approvals',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(agentRunDetailSchema, 'Run'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await getRun(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/agents/runs/{id}/cancel',
      tags: ['agents'],
      summary: 'Stop a queued, running or waiting run',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(agentRunSchema, 'Cancelled'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await cancelRun(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/agents/runs/{id}/undo',
      tags: ['agents'],
      summary: 'Undo every change the run made (one batch); 409 changed_since unless force',
      middleware,
      request: {
        headers: accountHeader,
        params: idParam,
        ...jsonBody(z.object({ force: z.boolean().optional() })),
      },
      responses: { 200: json(z.object({ ok: z.literal(true), undone: z.number().int() }), 'Undone'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await undoRun(deps, actorOf(c), c.req.valid('param').id, !!c.req.valid('json').force), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/agents/{id}',
      tags: ['agents'],
      summary: 'One agent',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(agentSchema, 'Agent'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await getAgent(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/agents/{id}',
      tags: ['agents'],
      summary: 'Change an agent (profile, model, tools, boards, approval mode, limits, on/off)',
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateAgentSchema) },
      responses: { 200: json(agentSchema, 'Updated'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(await updateAgent(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/agents/{id}/web-search/{decision}',
      tags: ['agents'],
      summary: "Approve or reject an agent's request to search the web (account admins; audited)",
      middleware,
      request: {
        headers: accountHeader,
        params: z.object({ id: z.string(), decision: z.enum(['approve', 'reject']) }),
      },
      responses: { 200: json(agentSchema, 'Decided'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const { id, decision } = c.req.valid('param');
      return c.json(await decideAgentWebSearch(deps, actorOf(c), id, decision === 'approve', requestMeta(c)), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/agents/{id}',
      tags: ['agents'],
      summary: 'Delete an agent (its runs and activity stay)',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await deleteAgent(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/agents/{id}/runs',
      tags: ['agents'],
      summary: 'Run the agent now with a prompt (dry_run: write tools only say what they would do)',
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(startAgentRunSchema) },
      responses: { 201: json(agentRunSchema, 'Started'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await startRun(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  return r;
};
