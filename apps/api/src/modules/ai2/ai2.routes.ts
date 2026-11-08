// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import {
  aiColumnInfoSchema,
  aiColumnRunRequestSchema,
  aiColumnRunSchema,
  aiConnectionOptionSchema,
  assistantContextSchema,
  assistantConversationSchema,
  assistantDecideSchema,
  assistantDecisionSchema,
  assistantMessageSchema,
  assistantSendSchema,
  assistantAgentSchema,
  assistantStatusSchema,
  type AiProvider,
  type AssistantStreamEvent,
  isChatProvider,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { listConnectionRows } from '../ai/ai.repo';
import {
  assistantStatus,
  createAssistantConversation,
  decideAssistantActions,
  deleteAssistantConversation,
  getAssistantConversation,
  listAssistantConversations,
  prepareAssistantMessage,
  sendAssistantMessage,
} from './assistant.service';
import { aiColumnInfo, getColumnRun, rejectAiOutput, runAiColumn } from './columns.service';
import { chatAgents } from './agent-chat';

/** AI columns (מ11) and the AI assistant panel (מ12) — the planning notes "AGENTS-MCP", D26. */
export const ai2Routes = (deps: AppDeps) => {
  const middleware = [requireAccount(deps)];
  const common = errors(400, 401, 403, 404, 409, 422, 423, 429);
  const r = new OpenAPIHono<AppEnv>();
  const columnParams = z.object({
    boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }),
    columnId: z.string().openapi({ param: { name: 'columnId', in: 'path' } }),
  });

  // ---- AI columns ----

  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai-columns/connections',
      tags: ['ai'],
      summary: 'AI connections an AI column may use (names only — never a key)',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(aiConnectionOptionSchema) }), 'Connections'), ...common },
    }),
    async (c) => {
      const a = actorOf(c);
      // Whoever may set up a column sees the names; guests never set up AI.
      // Chat providers only (a speech-only connection — Soniox — makes no column).
      const rows =
        a.ctx.role === 'guest'
          ? []
          : (await listConnectionRows(deps.db, a.ctx.accountId)).filter((x) =>
              isChatProvider(x.c.provider as AiProvider),
            );
      return c.json(
        {
          data: rows.map((x) => ({
            id: x.c.id,
            name: x.c.name,
            provider: x.c.provider,
            default_model: x.c.defaultModel,
          })),
        },
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/ai-columns/{columnId}',
      tags: ['ai'],
      summary: "An AI column: ready to run?, this month's spend, the latest runs",
      middleware,
      request: { headers: accountHeader, params: columnParams },
      responses: { 200: json(aiColumnInfoSchema, 'AI column'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await aiColumnInfo(deps, actorOf(c), p.boardId, p.columnId), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/ai-columns/{columnId}/run',
      tags: ['ai'],
      summary: 'Fill AI cells: given items, the empty cells or all (one undoable batch; large runs are queued)',
      middleware,
      request: { headers: accountHeader, params: columnParams, ...jsonBody(aiColumnRunRequestSchema) },
      responses: { 200: json(aiColumnRunSchema, 'The run'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await runAiColumn(deps, actorOf(c), p.boardId, p.columnId, c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/ai-columns/{columnId}/items/{itemId}/outputs/{fileId}/reject',
      tags: ['ai'],
      summary: 'Reject a design an AI column made: the file goes to the trash, the cell marks it rejected',
      middleware,
      request: {
        headers: accountHeader,
        params: columnParams.extend({
          itemId: z.string().openapi({ param: { name: 'itemId', in: 'path' } }),
          fileId: z.string().openapi({ param: { name: 'fileId', in: 'path' } }),
        }),
      },
      responses: {
        200: json(
          z.object({ item_id: z.string(), file_id: z.string(), rejected: z.literal(true) }),
          'The design is rejected',
        ),
        ...common,
      },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await rejectAiOutput(deps, actorOf(c), p.boardId, p.columnId, p.itemId, p.fileId), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/ai-columns/{columnId}/items/{itemId}/retry-missing',
      tags: ['ai'],
      summary: "Make an AI image cell's missing designs (failed or left pending) — never the ones already made",
      middleware,
      request: {
        headers: accountHeader,
        params: columnParams.extend({ itemId: z.string().openapi({ param: { name: 'itemId', in: 'path' } }) }),
      },
      responses: { 200: json(aiColumnRunSchema, 'The run'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      const req = { mode: 'items' as const, item_ids: [p.itemId], only_missing: true };
      return c.json(await runAiColumn(deps, actorOf(c), p.boardId, p.columnId, req), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai-columns/runs/{id}',
      tags: ['ai'],
      summary: 'An AI column run (progress, cost, errors)',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(aiColumnRunSchema, 'The run'), ...common },
    }),
    async (c) => c.json(await getColumnRun(deps, actorOf(c), c.req.valid('param').id), 200),
  );

  // ---- the assistant ----

  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/assistant/status',
      tags: ['ai'],
      summary: 'May I use the AI assistant here (and why not)?',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(assistantStatusSchema, 'Status'), ...common },
    }),
    async (c) => c.json(await assistantStatus(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/assistant/agents',
      tags: ['ai'],
      summary: 'The agents I may chat with in the AI panel',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(assistantAgentSchema) }), 'Agents'), ...common },
    }),
    async (c) => c.json(await chatAgents(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/assistant/conversations',
      tags: ['ai'],
      summary: 'My assistant conversations about a board or an item',
      middleware,
      request: { headers: accountHeader, query: assistantContextSchema },
      responses: {
        200: json(z.object({ data: z.array(assistantConversationSchema) }), 'Conversations'),
        ...common,
      },
    }),
    async (c) => c.json(await listAssistantConversations(deps, actorOf(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/ai/assistant/conversations',
      tags: ['ai'],
      summary: 'Start a conversation about a board or an item',
      middleware,
      request: { headers: accountHeader, ...jsonBody(assistantContextSchema) },
      responses: { 201: json(assistantConversationSchema, 'Created'), ...common },
    }),
    async (c) => c.json(await createAssistantConversation(deps, actorOf(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/assistant/conversations/{id}',
      tags: ['ai'],
      summary: 'A conversation with its messages',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: {
        200: json(
          z.object({ conversation: assistantConversationSchema, messages: z.array(assistantMessageSchema) }),
          'Conversation',
        ),
        ...common,
      },
    }),
    async (c) => c.json(await getAssistantConversation(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/ai/assistant/conversations/{id}',
      tags: ['ai'],
      summary: 'Delete a conversation from my history',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...common },
    }),
    async (c) => c.json(await deleteAssistantConversation(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/ai/assistant/conversations/{id}/messages',
      tags: ['ai'],
      summary: 'Send a message; the answer streams (text/event-stream: user, delta, read, action, done | error events)',
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(assistantSendSchema) },
      responses: {
        200: {
          description: 'text/event-stream; `data` = AssistantStreamEvent JSON',
          content: { 'text/event-stream': { schema: z.string() } },
        },
        ...common,
      },
    }),
    async (c) => {
      const a = actorOf(c);
      const { text, file_ids, refs } = c.req.valid('json');
      // Checks first, so refusals answer as ordinary HTTP errors.
      const prepared = await prepareAssistantMessage(deps, a, c.req.valid('param').id, text, file_ids, refs);
      c.header('Cache-Control', 'no-cache, no-transform');
      c.header('X-Accel-Buffering', 'no');
      return streamSSE(c, async (stream) => {
        let chain: Promise<unknown> = Promise.resolve();
        const emit = (e: AssistantStreamEvent) => {
          chain = chain.then(() => stream.writeSSE({ data: JSON.stringify(e) })).catch(() => {});
          return chain as Promise<void>;
        };
        try {
          await sendAssistantMessage(deps, a, prepared, text, emit);
        } catch (err) {
          deps.logger.error({ err }, 'assistant message failed');
          await emit({ type: 'error', code: 'internal' });
        }
        await chain;
      }) as never;
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/ai/assistant/messages/{id}/actions',
      tags: ['ai'],
      summary: 'Approve / reject proposed actions; approved ones run now as one undoable batch',
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(assistantDecideSchema) },
      responses: { 200: json(assistantDecisionSchema, 'Decided'), ...common },
    }),
    async (c) =>
      c.json(await decideAssistantActions(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  return r;
};
