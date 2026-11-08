// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { geoConfigSchema, placeSchema, placeSuggestionSchema, updateGeoSettingsSchema } from '@bines/shared';
import { requestMeta, requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './geo.service';

const common = errors(400, 401, 403, 404, 422);
const tags = ['geo'];

/** Maps and addresses (M8 ד10, D25): map config, address completion with the account's key, map settings. */
export const geoRoutes = (deps: AppDeps) => {
  const middleware = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/geo/config',
      tags,
      summary: 'The map style and what address lookups the account has',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(geoConfigSchema, 'Config'), ...common },
    }),
    async (c) => c.json(await svc.geoConfig(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/geo/settings',
      tags,
      summary: 'Map tiles, extra origins, geocoding and the Google key (admins; the key is write-only)',
      middleware,
      request: { headers: accountHeader, ...jsonBody(updateGeoSettingsSchema) },
      responses: { 200: json(geoConfigSchema, 'Config'), ...common },
    }),
    async (c) => c.json(await svc.updateGeoSettings(deps, actorOf(c), c.req.valid('json'), requestMeta(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/geo/autocomplete',
      tags,
      summary: 'Address suggestions while typing (only with an account Google key; else empty)',
      middleware,
      request: { headers: accountHeader, query: z.object({ q: z.string().max(200) }) },
      responses: { 200: json(z.object({ data: z.array(placeSuggestionSchema) }), 'Suggestions'), ...common },
    }),
    async (c) => c.json({ data: await svc.autocomplete(deps, actorOf(c), c.req.valid('query').q) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/geo/places/{placeId}',
      tags,
      summary: 'A suggested place with its address and coordinates',
      middleware,
      request: {
        headers: accountHeader,
        params: z.object({
          placeId: z
            .string()
            .max(300)
            .openapi({ param: { name: 'placeId', in: 'path' } }),
        }),
      },
      responses: { 200: json(placeSchema, 'Place'), ...common },
    }),
    async (c) => c.json(await svc.place(deps, actorOf(c), c.req.valid('param').placeId), 200),
  );
  return r;
};
