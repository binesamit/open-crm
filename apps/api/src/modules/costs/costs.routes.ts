// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  costAccountsSchema,
  costPriceInputSchema,
  costPriceListSchema,
  costPricePatchSchema,
  costPriceSchema,
  costRangeQuerySchema,
  costSettingsPatchSchema,
  costSettingsResponseSchema,
  costSourceInputSchema,
  costSourceListSchema,
  costSourcePatchSchema,
  costSourceSchema,
  costSummarySchema,
  costSyncInputSchema,
  costTestResultSchema,
} from '@bines/shared';
import { currentUser, requirePlatformOwner, requireUser } from '../../middleware/auth';
import { errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  costAccounts,
  costSummary,
  createCostPrice,
  createCostSource,
  deleteCostPrice,
  deleteCostSource,
  getCostSettings,
  listCostPrices,
  listCostSources,
  requestCostSync,
  testCostSource,
  updateCostPrice,
  updateCostSettings,
  updateCostSource,
} from './costs.service';

/** Owner console → Costs: the platform's costs, its sources, prices and settings. Owner only. */
export const costRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();
  const guard = [requireUser(), requirePlatformOwner()];
  const tags = ['platform'];
  const syncQueued = z.object({ ok: z.literal(true), queued: z.boolean() });

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/costs/summary',
      tags,
      summary: 'What the platform cost on these days, per day, source and service (platform owner)',
      middleware: guard,
      request: { query: costRangeQuerySchema },
      responses: { 200: json(costSummarySchema, 'Summary'), ...errors(400, 401, 404) },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(await costSummary(deps, q.from, q.to), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/costs/accounts',
      tags,
      summary: "Each account's costs on these days — its own and its share — against its plan (platform owner)",
      middleware: guard,
      request: { query: costRangeQuerySchema },
      responses: { 200: json(costAccountsSchema, 'Accounts'), ...errors(400, 401, 404) },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(await costAccounts(deps, q.from, q.to), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/costs/sources',
      tags,
      summary: 'The cost sources (platform owner)',
      middleware: guard,
      responses: { 200: json(costSourceListSchema, 'Sources'), ...errors(401, 404) },
    }),
    async (c) => c.json(await listCostSources(deps), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/costs/sources',
      tags,
      summary: 'Connect a cost source; it reads its past days at once (platform owner)',
      middleware: guard,
      request: jsonBody(costSourceInputSchema),
      responses: { 201: json(costSourceSchema, 'Source'), ...errors(400, 401, 404, 409, 422) },
    }),
    async (c) => c.json(await createCostSource(deps, currentUser(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/costs/sources/{id}',
      tags,
      summary: 'Change a cost source — name, settings, key, budget, on / off (platform owner)',
      middleware: guard,
      request: { params: idParam, ...jsonBody(costSourcePatchSchema) },
      responses: { 200: json(costSourceSchema, 'Source'), ...errors(400, 401, 404, 422) },
    }),
    async (c) =>
      c.json(await updateCostSource(deps, currentUser(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/costs/sources/{id}',
      tags,
      summary: 'Remove a cost source; its days leave the reports (platform owner)',
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(okSchema, 'Removed'), ...errors(401, 404, 409) },
    }),
    async (c) => c.json(await deleteCostSource(deps, currentUser(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/costs/sources/{id}/test',
      tags,
      summary: "Read a source's last day without storing it — does the connection work (platform owner)",
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(costTestResultSchema, 'Test'), ...errors(401, 404) },
    }),
    async (c) => c.json(await testCostSource(deps, c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/costs/sync',
      tags,
      summary: 'Read one source or all again now, optionally further back (platform owner)',
      middleware: guard,
      request: jsonBody(costSyncInputSchema),
      responses: { 200: json(syncQueued, 'Queued'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await requestCostSync(deps, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/costs/prices',
      tags,
      summary: 'The unit-price table (platform owner)',
      middleware: guard,
      responses: { 200: json(costPriceListSchema, 'Prices'), ...errors(401, 404) },
    }),
    async (c) => c.json(await listCostPrices(deps), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/costs/prices',
      tags,
      summary: 'Add a unit price; the days it covers are priced again (platform owner)',
      middleware: guard,
      request: jsonBody(costPriceInputSchema),
      responses: { 201: json(costPriceSchema, 'Price'), ...errors(400, 401, 404, 409) },
    }),
    async (c) => c.json(await createCostPrice(deps, currentUser(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/costs/prices/{id}',
      tags,
      summary: 'Change a unit price; the days it covers are priced again (platform owner)',
      middleware: guard,
      request: { params: idParam, ...jsonBody(costPricePatchSchema) },
      responses: { 200: json(costPriceSchema, 'Price'), ...errors(400, 401, 404, 409) },
    }),
    async (c) => c.json(await updateCostPrice(deps, currentUser(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/costs/prices/{id}',
      tags,
      summary: 'Remove a unit price (platform owner)',
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(okSchema, 'Removed'), ...errors(401, 404) },
    }),
    async (c) => c.json(await deleteCostPrice(deps, currentUser(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/costs/settings',
      tags,
      summary: 'Currency, exchange rates, sync hour, budgets and alerts (platform owner)',
      middleware: guard,
      responses: { 200: json(costSettingsResponseSchema, 'Settings'), ...errors(401, 404) },
    }),
    async (c) => c.json(await getCostSettings(deps), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/costs/settings',
      tags,
      summary: 'Change the costs settings (platform owner)',
      middleware: guard,
      request: jsonBody(costSettingsPatchSchema),
      responses: { 200: json(costSettingsResponseSchema, 'Settings'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await updateCostSettings(deps, currentUser(c), c.req.valid('json')), 200),
  );
  return r;
};
