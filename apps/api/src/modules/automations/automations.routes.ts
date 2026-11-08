// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  accountAutomationSchema,
  automationListSchema,
  automationUsageSchema,
  automationRunSchema,
  automationRunsQuerySchema,
  automationSavedSchema,
  automationSchema,
  automationTestResultSchema,
  computedPreviewResultSchema,
  computedPreviewSchema,
  createAutomationSchema,
  testAutomationSchema,
  updateAutomationSchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, idParam, json, jsonBody, okSchema, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { parseIfMatch } from '../views/views.service';
import * as svc from './automations.service';

const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });
const ifMatchHeader = accountHeader.extend({
  'if-match': z
    .string()
    .optional()
    .openapi({ param: { name: 'if-match', in: 'header' }, description: 'Automation revision being saved over' }),
});

/** Automations (06 §2.16, 04-AUTOMATIONS): a board's rules, their runs, and a test run. */
export const automationRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/automations',
      tags: ['automations'],
      summary: "The board's automations",
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: { 200: json(automationListSchema, 'Automations'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.listAutomations(db, actorOf(c), c.req.valid('param').boardId), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/automations',
      tags: ['automations'],
      summary: 'Create an automation (recipe validated against the board; seed shorthands accepted)',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(createAutomationSchema) },
      responses: { 201: json(automationSavedSchema, 'Created'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(await svc.createAutomation(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/automations/computed-preview',
      tags: ['automations'],
      summary: 'Preview a computed value (set_computed) on a few items of the board — nothing is written',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(computedPreviewSchema) },
      responses: { 200: json(computedPreviewResultSchema, 'Results'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(await svc.previewComputed(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/automations',
      tags: ['automations'],
      summary: 'Every automation of the boards I can read, with its board and the last 7 days',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(accountAutomationSchema) }), 'Automations'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.listAccountAutomations(db, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/automations/usage',
      tags: ['automations'],
      summary: 'Runs per day (30 days) by outcome, actions carried out, scheduled fires due in 24 h',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(automationUsageSchema, 'Usage'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.automationUsage(db, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/automations/{id}',
      tags: ['automations'],
      summary: 'One automation',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(automationSchema, 'Automation'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.getAutomation(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/automations/{id}',
      tags: ['automations'],
      summary: 'Edit, switch on/off, or transfer an automation (If-Match on the revision)',
      middleware: scoped,
      request: { headers: ifMatchHeader, params: idParam, ...jsonBody(updateAutomationSchema) },
      responses: { 200: json(automationSavedSchema, 'Automation'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(
        await svc.updateAutomation(
          db,
          actorOf(c),
          c.req.valid('param').id,
          c.req.valid('json'),
          parseIfMatch(c.req.valid('header')['if-match']),
        ),
        200,
      ),
  );
  for (const [path, is_active] of [
    ['activate', true],
    ['deactivate', false],
  ] as const)
    r.openapi(
      createRoute({
        method: 'post',
        path: `/automations/{id}/${path}`,
        tags: ['automations'],
        summary: is_active ? 'Switch an automation on' : 'Switch an automation off',
        middleware: scoped,
        request: { headers: accountHeader, params: idParam },
        responses: { 200: json(automationSavedSchema, 'Automation'), ...COMMON_ERRORS },
      }),
      async (c) =>
        c.json(await svc.updateAutomation(db, actorOf(c), c.req.valid('param').id, { is_active }, null), 200),
    );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/automations/{id}',
      tags: ['automations'],
      summary: 'Delete an automation',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.deleteAutomation(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/automations/{id}/runs',
      tags: ['automations'],
      summary: 'Run history, newest first (`before` = the last id of the previous page)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, query: automationRunsQuerySchema },
      responses: {
        200: json(z.object({ data: z.array(automationRunSchema), next: z.string().nullable() }), 'Runs'),
        ...COMMON_ERRORS,
      },
    }),
    async (c) => c.json(await svc.listRuns(db, actorOf(c), c.req.valid('param').id, c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/automations/{id}/test',
      tags: ['automations'],
      summary: 'Test on an item: dry run (preview, nothing written) or a real run',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(testAutomationSchema) },
      responses: { 200: json(automationTestResultSchema, 'Result'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.testAutomation(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  return r;
};
