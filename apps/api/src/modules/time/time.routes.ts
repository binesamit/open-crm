// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  addTimeEntrySchema,
  runningTimerSchema,
  startTimerSchema,
  timeEntrySchema,
  timeReportQuerySchema,
  timeReportSchema,
  updateTimeEntrySchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, idParam, json, jsonBody, okSchema, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './time.service';
import { itemTimeCsv, timeReport, timeReportCsv } from './report.service';

const tags = ['time'];

/** Time tracking (03 §3.3): timer start/stop, the item's log, manual entries; the cell is a cache. */
export const timeRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const middleware = [requireAccount(deps)];
  const params = { headers: accountHeader, params: idParam };
  const r = new OpenAPIHono<AppEnv>();

  const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });
  const csv = (body: string, name: string) =>
    new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
      },
    });
  const csvResponse = {
    200: { description: 'CSV', content: { 'text/csv': { schema: z.string() } } },
    ...COMMON_ERRORS,
  };
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/time/report',
      tags,
      summary: 'Time report of the board and its subitems: by user, item or day, over local days',
      middleware,
      request: { headers: accountHeader, params: boardParam, query: timeReportQuerySchema },
      responses: { 200: json(timeReportSchema, 'Report'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await timeReport(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/time/report.csv',
      tags,
      summary: 'The report entries as CSV (one row per entry, decimal hours for billing)',
      middleware,
      request: { headers: accountHeader, params: boardParam, query: timeReportQuerySchema },
      responses: csvResponse,
    }),
    async (c) =>
      csv(
        await timeReportCsv(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('query')),
        'time-report.csv',
      ) as never,
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/items/{id}/time/entries.csv',
      tags,
      summary: "The item's time log as CSV",
      middleware,
      request: params,
      responses: csvResponse,
    }),
    async (c) => csv(await itemTimeCsv(db, actorOf(c), c.req.valid('param').id), 'time-log.csv') as never,
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/time/start',
      tags,
      summary: 'Start my timer on this cell (others keep running; idempotent per cell)',
      middleware,
      request: { ...params, ...jsonBody(startTimerSchema) },
      responses: { 200: json(timeEntrySchema, 'Started'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.startTimer(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/time/stop',
      tags,
      summary: 'Stop my running timer on this item (one column, or all of them)',
      middleware,
      request: { ...params, ...jsonBody(z.object({ column_id: z.string().optional() })) },
      responses: { 200: json(timeEntrySchema, 'Stopped'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(await svc.stopTimer(db, actorOf(c), c.req.valid('param').id, c.req.valid('json').column_id), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/items/{id}/time/entries',
      tags,
      summary: 'The item time log, newest first',
      middleware,
      request: params,
      responses: { 200: json(z.object({ data: z.array(timeEntrySchema) }), 'Entries'), ...COMMON_ERRORS },
    }),
    async (c) => c.json({ data: await svc.listEntries(db, actorOf(c), c.req.valid('param').id) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/time/entries',
      tags,
      summary: 'Add a manual entry (start + end or start + duration; ≤24h, not in the future)',
      middleware,
      request: { ...params, ...jsonBody(addTimeEntrySchema) },
      responses: { 201: json(timeEntrySchema, 'Added'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.addEntry(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/time/entries/{id}',
      tags,
      summary: 'Edit an entry (mine, or any as board owner / admin); marked as edited',
      middleware,
      request: { ...params, ...jsonBody(updateTimeEntrySchema) },
      responses: { 200: json(timeEntrySchema, 'Updated'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.editEntry(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/time/entries/{id}',
      tags,
      summary: 'Delete an entry (to trash)',
      middleware,
      request: params,
      responses: { 200: json(okSchema, 'Deleted'), ...COMMON_ERRORS },
    }),
    async (c) => {
      await svc.deleteEntry(db, actorOf(c), c.req.valid('param').id);
      return c.json({ ok: true as const }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/time/running',
      tags,
      summary: 'All my running timers in this account',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(runningTimerSchema) }), 'Running'), ...COMMON_ERRORS },
    }),
    async (c) => c.json({ data: await svc.myRunningTimers(db, actorOf(c)) }, 200),
  );
  return r;
};
