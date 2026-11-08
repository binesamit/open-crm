// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { navLayoutResponseSchema, setAccountNavSchema, setMyNavSchema } from '@bines/shared';
import { actorOf, requestMeta, requireAccount } from '../../middleware/auth';
import { accountHeader, errors, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { myNav, setAccountNav, setMyNav } from './nav.service';

/** the sidebar / top bar layout — mine in this account, and the account's default (admins). */
export const navRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/nav',
      tags: ['me'],
      summary: "Where the shell's places sit for me here (sidebar / top bar): in effect, mine, the account's default",
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(navLayoutResponseSchema, 'Layout'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await myNav(db, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/me/nav',
      tags: ['me'],
      summary: "Set my own layout in this account (null = follow the account's default); refused while it is locked",
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(setMyNavSchema) },
      responses: { 200: json(navLayoutResponseSchema, 'Layout'), ...errors(400, 401, 403, 404) },
    }),
    async (c) => c.json(await setMyNav(db, actorOf(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/accounts/me/nav',
      tags: ['accounts'],
      summary: "Set the account's default layout and whether members may change it (admin)",
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(setAccountNavSchema) },
      responses: { 200: json(navLayoutResponseSchema, 'Layout'), ...errors(400, 401, 403, 404) },
    }),
    async (c) => c.json(await setAccountNav(db, actorOf(c), c.req.valid('json'), requestMeta(c)), 200),
  );

  return r;
};
