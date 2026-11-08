// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  addAgentKnowledgeSchema,
  agentAutomationRefSchema,
  agentDirectorySchema,
  agentKnowledgeSchema,
  improveAgentInstructionsSchema,
  improvedAgentInstructionsSchema,
} from '@bines/shared';
import type { MiddlewareHandler } from 'hono';
import { requestMeta, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { agentAutomations, agentDirectory } from './agents.service';
import { improveAgentInstructions } from './improve.service';
import { addKnowledge, listKnowledge, reindexKnowledge, removeKnowledge } from './knowledge.service';

/**
 * Agents stages מ8–מ9: the directory of "digital workers" (mention list, people pickers), the automations that run
 * an agent, and its knowledge base. Registered before `/agents/{id}` (so `/agents/directory` is not an id).
 */
export const registerAgentExtraRoutes = (
  r: OpenAPIHono<AppEnv>,
  deps: AppDeps,
  middleware: MiddlewareHandler<AppEnv>[],
) => {
  const common = errors(400, 401, 403, 404, 409, 413, 422, 423);
  const sourceParams = z.object({
    id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    sourceId: z.string().openapi({ param: { name: 'sourceId', in: 'path' } }),
  });

  r.openapi(
    createRoute({
      method: 'get',
      path: '/agents/directory',
      tags: ['agents'],
      summary: 'Agents that act on a mention / an assignment ("digital workers" in mention lists and people pickers)',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(agentDirectorySchema, 'Agents'), ...common },
    }),
    async (c) => c.json(await agentDirectory(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/agents/improve-instructions',
      tags: ['agents'],
      summary: "Rewrite an agent's instructions with AI from the editor's current state (nothing is saved)",
      description:
        'The chosen AI connection rewrites the instructions using the agent name, role, tools and boards given. ' +
        'Counts as AI usage and against the AI change rate; the answer is only returned — save the agent to keep it.',
      middleware,
      request: { headers: accountHeader, ...jsonBody(improveAgentInstructionsSchema) },
      responses: {
        200: json(improvedAgentInstructionsSchema, 'The rewritten instructions'),
        ...errors(429),
        ...common,
      },
    }),
    async (c) => c.json(await improveAgentInstructions(deps, actorOf(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/agents/{id}/automations',
      tags: ['agents'],
      summary: 'Automations that run this agent (run_agent)',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(z.object({ data: z.array(agentAutomationRefSchema) }), 'Automations'), ...common },
    }),
    async (c) => c.json(await agentAutomations(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/agents/{id}/knowledge',
      tags: ['agents'],
      summary: "The agent's knowledge sources and their indexing status",
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(z.object({ data: z.array(agentKnowledgeSchema) }), 'Sources'), ...common },
    }),
    async (c) => c.json(await listKnowledge(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/agents/{id}/knowledge',
      tags: ['agents'],
      summary: 'Add a knowledge source: my uploaded file (PDF/DOCX/TXT/MD), a doc, a board or a note',
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(addAgentKnowledgeSchema) },
      responses: { 201: json(agentKnowledgeSchema, 'Added'), ...common },
    }),
    async (c) =>
      c.json(await addKnowledge(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)), 201),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/agents/{id}/knowledge/{sourceId}/reindex',
      tags: ['agents'],
      summary: 'Read a knowledge source again (a doc that changed, a file that failed)',
      middleware,
      request: { headers: accountHeader, params: sourceParams },
      responses: { 200: json(agentKnowledgeSchema, 'Queued'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await reindexKnowledge(deps, actorOf(c), p.id, p.sourceId), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/agents/{id}/knowledge/{sourceId}',
      tags: ['agents'],
      summary: 'Remove a knowledge source (out of the index at once)',
      middleware,
      request: { headers: accountHeader, params: sourceParams },
      responses: { 200: json(okSchema, 'Removed'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await removeKnowledge(deps, actorOf(c), p.id, p.sourceId, requestMeta(c)), 200);
    },
  );
};
