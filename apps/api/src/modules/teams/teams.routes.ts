// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { createTeamSchema, teamListSchema, teamSchema, updateTeamSchema } from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, idParam, json, jsonBody, okSchema, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './teams.service';

/** Teams (05 §7): everyone but guests reads them; admins manage them. */
export const teamRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/teams',
      tags: ['teams'],
      summary: 'Teams of the account with their members',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(teamListSchema, 'Teams'), ...COMMON_ERRORS },
    }),
    async (c) => c.json({ data: await svc.listTeams(db, actorOf(c)) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/teams',
      tags: ['teams'],
      summary: 'Create a team (admins)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(createTeamSchema) },
      responses: { 201: json(teamSchema, 'Team'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.createTeam(db, actorOf(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/teams/{id}',
      tags: ['teams'],
      summary: 'Rename / recolour a team or replace its members (admins)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateTeamSchema) },
      responses: { 200: json(teamSchema, 'Team'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.updateTeam(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/teams/{id}',
      tags: ['teams'],
      summary: 'Delete a team (admins)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...COMMON_ERRORS },
    }),
    async (c) => {
      await svc.deleteTeam(db, actorOf(c), c.req.valid('param').id);
      return c.json({ ok: true as const }, 200);
    },
  );
  return r;
};
