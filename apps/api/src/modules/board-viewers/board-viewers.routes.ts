// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { boardViewersQuerySchema, boardViewersSchema, markBoardViewResultSchema } from '@bines/shared';
import type { Context } from 'hono';
import { currentUser, requireAccount } from '../../middleware/auth';
import { accountHeader, errors, idParam, json } from '../../lib/openapi';
import { RateLimiter, rateLimit } from '../../lib/rate-limit';
import type { AppDeps, AppEnv } from '../../types';
import { deviceOf } from '../updates/device';
import { listBoardViewers, markBoardViewed } from './board-viewers.service';

/** Board opens per person: writes are throttled per board anyway; this only stops a runaway client. */
const openReports = new RateLimiter(120, 60_000);

const tags = ['boards'];

/** r18boardviews: who viewed a board, and how long ago. */
export const boardViewerRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const middleware = [requireAccount(deps)];
  const actor = (c: Context<AppEnv>) => ({ ctx: c.get('account'), user: currentUser(c) });
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{id}/viewers',
      tags,
      summary: 'Report that I opened the board (at most one write per person per 5 minutes; device from headers)',
      middleware: [...middleware, rateLimit(openReports, (c) => `board-open:${currentUser(c).id}`)],
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(markBoardViewResultSchema, 'Recorded'), ...errors(401, 404, 429) },
    }),
    async (c) => {
      const device = deviceOf(c.req.header('user-agent'), c.req.header('sec-ch-ua-mobile'));
      const recorded = await markBoardViewed(db, actor(c), c.req.valid('param').id, device);
      return c.json({ ok: true as const, recorded }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{id}/viewers',
      tags,
      summary: 'Who viewed the board, newest first (guests see only themselves)',
      middleware,
      request: { headers: accountHeader, params: idParam, query: boardViewersQuerySchema },
      responses: { 200: json(boardViewersSchema, 'Viewers'), ...errors(400, 401, 404) },
    }),
    async (c) =>
      c.json(await listBoardViewers(db, actor(c), c.req.valid('param').id, c.req.valid('query'), deps.storage), 200),
  );
  return r;
};
