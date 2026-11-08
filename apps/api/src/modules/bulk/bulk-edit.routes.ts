// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { bulkEditResultSchema, bulkEditSchema, bulkEditUndoResultSchema, bulkEditUndoSchema } from '@bines/shared';
import { requireAccount, actorOf, requestMeta } from '../../middleware/auth';
import { accountHeader, json, jsonBody, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { bulkEdit, undoBulkEdit } from './bulk-edit.service';

const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });
const batchParams = boardParam.extend({
  batchId: z.string().openapi({ param: { name: 'batchId', in: 'path' } }),
});
/** "ייבוא ועריכה" (12-ROADMAP B2; "עריכה גדולה" until): the sheet's draft written as one batch, and its one-step undo. */
export const bulkEditRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/items/bulk-edit',
      tags: ['items'],
      summary:
        'Bulk edit / file import: new columns, labels, tags, then up to 10,000 rows (updates and new items) as one batch',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(bulkEditSchema) },
      responses: { 200: json(bulkEditResultSchema, 'Written'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(
        await bulkEdit(
          deps,
          // Secrets need the session or the token for their step-up and audit.
          { ...actorOf(c), sessionId: c.get('sessionId') ?? null, token: c.get('token') ?? null, meta: requestMeta(c) },
          c.req.valid('param').boardId,
          c.req.valid('json'),
        ),
        200,
      ),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/items/bulk-edit/{batchId}/undo',
      tags: ['items'],
      summary: 'Undo a bulk edit: cells and names back, new items and columns to trash, new labels removed',
      middleware: scoped,
      request: { headers: accountHeader, params: batchParams, ...jsonBody(bulkEditUndoSchema) },
      responses: { 200: json(bulkEditUndoResultSchema, 'Undone'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const { boardId, batchId } = c.req.valid('param');
      return c.json(await undoBulkEdit(db, actorOf(c), boardId, batchId, !!c.req.valid('json').force), 200);
    },
  );
  return r;
};
