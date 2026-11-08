// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { myWorkSchema, myWorkSettingsSchema, patchMyWorkSettingsSchema } from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { myWork, updateMyWorkSettings } from './mywork.service';

/** My Work (07 §9.2, 06 §2.23). Edits on it go through the usual item endpoints. */
export const myWorkRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/work',
      tags: ['my-work'],
      summary: 'Items I or my teams are assigned to, by deadline section (past / today / this week / …)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(myWorkSchema, 'My Work'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await myWork(db, actorOf(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/me/work/settings',
      tags: ['my-work'],
      summary: 'Customize My Work: hide done, group by, per board hide / date column / status column',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(patchMyWorkSettingsSchema) },
      responses: { 200: json(myWorkSettingsSchema, 'Settings'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await updateMyWorkSettings(db, actorOf(c), c.req.valid('json')), 200),
  );

  return r;
};
