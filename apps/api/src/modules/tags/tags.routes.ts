// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { createTagSchema, tagListSchema, tagSchema } from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, json, jsonBody, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './tags.service';

/** Account-wide tags (03 §3.1, 06 §2.22). */
export const tagRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/tags',
      tags: ['tags'],
      summary: 'Tags of the account',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(tagListSchema, 'Tags'), ...COMMON_ERRORS },
    }),
    async (c) => c.json({ data: await svc.listTags(db, actorOf(c)) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/tags',
      tags: ['tags'],
      summary: 'Create a tag (or return the one with this name)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(createTagSchema) },
      responses: { 201: json(tagSchema, 'Tag'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.createTag(db, actorOf(c), c.req.valid('json')), 201),
  );
  return r;
};
