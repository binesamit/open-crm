// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  createScenarioSchema,
  scenarioRunSchema,
  scenarioSchema,
  setScenarioActiveSchema,
  testScenarioSchema,
  updateScenarioSchema,
} from '@bines/shared';
import { actorOf, requireAccount } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './scenarios.service';

const common = errors(400, 401, 403, 404, 409, 422);
const deleted = z.object({ ok: z.literal(true), id: z.string() });

/** Scenarios (phase 3): a board's graph automations, their switch, runs and a test run. */
export const scenarioRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();
  const tags = ['scenarios'];

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{id}/scenarios',
      tags,
      summary: "A board's scenarios",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(z.object({ data: z.array(scenarioSchema) }), 'Scenarios'), ...common },
    }),
    async (c) => c.json({ data: await svc.listScenarios(db, actorOf(c), c.req.valid('param').id) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{id}/scenarios',
      tags,
      summary: 'Create a scenario (off until switched on)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(createScenarioSchema) },
      responses: { 201: json(scenarioSchema, 'Created'), ...common },
    }),
    async (c) => c.json(await svc.createScenario(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/scenarios/{id}',
      tags,
      summary: 'One scenario with its graph and issues',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(scenarioSchema, 'Scenario'), ...common },
    }),
    async (c) => c.json(await svc.getScenario(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/scenarios/{id}',
      tags,
      summary: 'Rename a scenario or save its graph (the saver becomes its owner)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateScenarioSchema) },
      responses: { 200: json(scenarioSchema, 'Updated'), ...common },
    }),
    async (c) => c.json(await svc.updateScenario(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/scenarios/{id}/active',
      tags,
      summary: 'Switch a scenario on or off (on needs a graph without issues)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(setScenarioActiveSchema) },
      responses: { 200: json(scenarioSchema, 'Switched'), ...common },
    }),
    async (c) =>
      c.json(await svc.setScenarioActive(db, actorOf(c), c.req.valid('param').id, c.req.valid('json').active), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/scenarios/{id}',
      tags,
      summary: 'Delete a scenario',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(deleted, 'Deleted'), ...common },
    }),
    async (c) => {
      const id = c.req.valid('param').id;
      await svc.deleteScenario(db, actorOf(c), id);
      return c.json({ ok: true as const, id }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/scenarios/{id}/runs',
      tags,
      summary: "A scenario's runs, newest first, with each step's input, output or error",
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: idParam,
        query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
      },
      responses: { 200: json(z.object({ data: z.array(scenarioRunSchema) }), 'Runs'), ...common },
    }),
    async (c) =>
      c.json(
        {
          data: await svc.listScenarioRuns(db, actorOf(c), c.req.valid('param').id, c.req.valid('query').limit),
        },
        200,
      ),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/scenarios/{id}/test',
      tags,
      summary: 'Run the scenario on an item now (its actions happen), even while it is off',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(testScenarioSchema) },
      responses: { 200: json(scenarioRunSchema, 'The run'), ...common },
    }),
    async (c) =>
      c.json(await svc.testScenario(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json').item_id), 200),
  );
  return r;
};
