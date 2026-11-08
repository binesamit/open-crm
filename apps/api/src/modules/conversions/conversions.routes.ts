// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  conversionPreviewSchema,
  conversionRestoreSchema,
  conversionSchema,
  conversionSettingsSchema,
  conversionUndoSchema,
  convertRequestSchema,
  failedConversionsSchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, json, jsonBody, okSchema, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { undoEvent } from '../activity/undo.service';
import {
  clearFailedMarks,
  conversionSettings,
  convertColumn,
  failedConversionCells,
  getConversion,
  listConversions,
  restoreConversion,
  setConversionSettings,
} from './conversions.service';
import { AppError } from '@bines/shared';

const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });
const columnParams = boardParam.extend({
  columnId: z.string().openapi({ param: { name: 'columnId', in: 'path' } }),
});
const conversionParams = boardParam.extend({
  conversionId: z.string().openapi({ param: { name: 'conversionId', in: 'path' } }),
});
const convertResponse = z.object({
  ok: z.literal(true),
  /** dry_run: what the conversion would do. */
  preview: conversionPreviewSchema.optional(),
  /** The conversion (done, or running in the background). */
  conversion: conversionSchema.optional(),
});
const restorePreviewSchema = z.object({
  counts: conversionPreviewSchema.shape.counts,
  /** Cells changed since the conversion (kept as they are unless `force`). */
  changed_since: z.number(),
  dependents: conversionPreviewSchema.shape.dependents,
  fingerprint: z.string(),
  to_type: z.string(),
});
const restoreResponse = z.object({
  ok: z.literal(true),
  preview: restorePreviewSchema.optional(),
  conversion: conversionSchema.optional(),
});

/** Column type conversion (D28): preview + convert, history, undo, restore from backup, failed-cell marks. */
export const conversionRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/columns/{columnId}/convert',
      tags: ['columns'],
      summary:
        "Change a column's type: dry_run = the preview (counts, examples, new labels, what else is affected); else convert (needs the preview's fingerprint)",
      middleware: scoped,
      request: { headers: accountHeader, params: columnParams, ...jsonBody(convertRequestSchema) },
      responses: { 200: json(convertResponse, 'Preview or conversion'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      const out = await convertColumn(db, actorOf(c), p.boardId, p.columnId, c.req.valid('json'));
      return c.json({ ok: true as const, ...out }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/conversions',
      tags: ['columns'],
      summary: "The board's column type changes, newest first (one column with ?column_id=)",
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: boardParam,
        query: z.object({ column_id: z.string().max(64).optional() }),
      },
      responses: { 200: json(z.object({ data: z.array(conversionSchema) }), 'History'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(await listConversions(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('query').column_id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/conversions/failed',
      tags: ['columns'],
      summary: 'Cells that failed in recent conversions (their original values), for the marks and the filter',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: { 200: json(failedConversionsSchema, 'Failed cells'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await failedConversionCells(db, actorOf(c), c.req.valid('param').boardId), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/conversions/{conversionId}',
      tags: ['columns'],
      summary: 'A conversion: status, progress, counts and its report',
      middleware: scoped,
      request: { headers: accountHeader, params: conversionParams },
      responses: { 200: json(conversionSchema, 'The conversion'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await getConversion(db, actorOf(c), p.boardId, p.conversionId), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/conversions/{conversionId}/undo',
      tags: ['columns'],
      summary: 'Undo a conversion: type, settings, every value and the dependents back (as undoing its event)',
      middleware: scoped,
      request: { headers: accountHeader, params: conversionParams, ...jsonBody(conversionUndoSchema) },
      responses: { 200: json(z.object({ ok: z.literal(true), undone: z.number() }), 'Undone'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      const a = actorOf(c);
      const conv = await getConversion(db, a, p.boardId, p.conversionId);
      if (!conv.event_id) throw new AppError('not_undoable', 'not_done');
      const res = await undoEvent(db, a, conv.event_id, !!c.req.valid('json').force);
      return c.json({ ok: true as const, undone: res.undone }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/conversions/{conversionId}/restore',
      tags: ['columns'],
      summary: 'Restore the original type and values from the backup (dry_run = preview; needs its fingerprint)',
      middleware: scoped,
      request: { headers: accountHeader, params: conversionParams, ...jsonBody(conversionRestoreSchema) },
      responses: { 200: json(restoreResponse, 'Preview or restore'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      const out = await restoreConversion(db, actorOf(c), p.boardId, p.conversionId, c.req.valid('json'));
      return c.json({ ok: true as const, ...out }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/conversions/{conversionId}/clear-failed',
      tags: ['columns'],
      summary: 'Stop marking the cells that failed in a conversion (the backup stays)',
      middleware: scoped,
      request: { headers: accountHeader, params: conversionParams },
      responses: { 200: json(okSchema, 'Cleared'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await clearFailedMarks(db, actorOf(c), p.boardId, p.conversionId), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/conversions/settings',
      tags: ['columns'],
      summary: 'How long column conversion backups are kept',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(conversionSettingsSchema, 'Settings'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await conversionSettings(db, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/conversions/settings',
      tags: ['columns'],
      summary: 'Set how long column conversion backups are kept (admins)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(conversionSettingsSchema) },
      responses: { 200: json(conversionSettingsSchema, 'Settings'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await setConversionSettings(db, actorOf(c), c.req.valid('json')), 200),
  );
  return r;
};
