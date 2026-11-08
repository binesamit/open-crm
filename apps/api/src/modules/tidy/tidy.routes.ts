// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  TIDY_RULE_KEYS,
  tidyPreviewSchema,
  tidyRunSchema,
  tidySettingsSchema,
  updateTidyRulesSchema,
} from '@bines/shared';
import { requestMeta, requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, idParam, json, jsonBody, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  getTidySettings,
  listTidyRuns,
  previewTidy,
  runTidyNow,
  tidyRunCsv,
  updateTidyRules,
} from './cleaning.service';

/** Administration → סדר וניקיון → ניקוי מתוזמן (M8 ד13). Admins only (the service checks). */
export const tidyRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const middleware = [requireAccount(deps)];
  const tags = ['tidy'];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/admin/tidy/rules',
      tags,
      summary: 'The scheduled cleaning rules (defaults filled in) and the last run (admin)',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(tidySettingsSchema, 'Rules'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await getTidySettings(db, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/admin/tidy/rules',
      tags,
      summary: 'Change cleaning rules — only the rules sent change; audited tidy.rules_changed (admin)',
      middleware,
      request: { headers: accountHeader, ...jsonBody(updateTidyRulesSchema) },
      responses: { 200: json(tidySettingsSchema, 'Rules'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await updateTidyRules(db, actorOf(c), c.req.valid('json'), requestMeta(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/admin/tidy/preview',
      tags,
      summary: 'Dry run: what the enabled rules (or the ones named) would do now — counts and a sample (admin)',
      middleware,
      request: {
        headers: accountHeader,
        ...jsonBody(z.object({ rules: z.array(z.enum(TIDY_RULE_KEYS)).max(TIDY_RULE_KEYS.length).optional() })),
      },
      responses: { 200: json(tidyPreviewSchema, 'Preview'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await previewTidy(db, actorOf(c), { only: c.req.valid('json').rules }), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/admin/tidy/run',
      tags,
      summary: 'Run the enabled cleaning rules now — audited tidy.run (admin)',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(tidyRunSchema, 'Run'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await runTidyNow(db, actorOf(c), requestMeta(c), deps.logger), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/admin/tidy/runs',
      tags,
      summary: 'The latest cleaning runs (admin)',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(tidyRunSchema) }), 'Runs'), ...COMMON_ERRORS },
    }),
    async (c) => c.json({ data: await listTidyRuns(db, actorOf(c)) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/admin/tidy/runs/{id}/export.csv',
      tags,
      summary: 'What one cleaning run touched, as CSV (admin)',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: z.string() } } }, ...COMMON_ERRORS },
    }),
    async (c) =>
      new Response(await tidyRunCsv(db, actorOf(c), c.req.valid('param').id), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="tidy-run.csv"',
        },
      }) as never,
  );
  return r;
};
