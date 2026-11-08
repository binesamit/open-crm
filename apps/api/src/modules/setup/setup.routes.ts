// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { setupOwnerSchema, setupResultSchema, setupStatusSchema } from '@bines/shared';
import { requestMeta } from '../../middleware/auth';
import { errors, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { createOwner, setupStatus } from './setup.service';

/** First-run setup (public, no session): is it open, and "create the owner account" — see setup.service.ts. */
export const setupRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/setup',
      tags: ['system'],
      summary: 'Public: whether the installation still needs its owner account (first-run setup)',
      responses: { 200: json(setupStatusSchema, 'Setup status') },
    }),
    async (c) => c.json(await setupStatus(deps), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/setup',
      tags: ['system'],
      summary: 'Public, once: create the owner account (platform owner + first admin) while no user exists',
      request: jsonBody(setupOwnerSchema),
      responses: {
        200: json(setupResultSchema, 'Owner created and signed in (session cookie set)'),
        ...errors(400, 403, 409, 422),
      },
    }),
    async (c) => {
      const { cookies, account } = await createOwner(deps, c.req.valid('json'), requestMeta(c), {
        origin: c.req.header('origin'),
        host: c.req.header('host'),
      });
      for (const cookie of cookies) c.header('set-cookie', cookie, { append: true });
      return c.json({ ok: true as const, account: { id: account.id, slug: account.slug, name: account.name } }, 200);
    },
  );

  return r;
};
