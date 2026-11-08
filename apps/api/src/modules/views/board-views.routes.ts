// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  AppError,
  boardChartDataSchema,
  boardFilesSchema,
  buttonClickSchema,
  buttonResultSchema,
  chartRequestSchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { boardFiles } from '../files/board-files.service';
import { clickButton, linkedForButton } from '../items/button.service';
import { boardChart } from './chart.service';

const common = errors(400, 401, 403, 404, 422, 423);

/** M8 ד9–ד11: the Files and Chart views of a board, and the button column's click. */
export const boardViewRoutes = (deps: AppDeps) => {
  const middleware = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{id}/files',
      tags: ['views'],
      summary: 'Every file on the board (file columns + updates, items and subitems) the reader may see',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(boardFilesSchema, 'Files'), ...common },
    }),
    async (c) => c.json(await boardFiles(deps.db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{id}/chart',
      tags: ['views'],
      summary: 'Chart data of the board under a query (the Chart view of a large board)',
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(chartRequestSchema) },
      responses: { 200: json(boardChartDataSchema, 'Chart data'), ...common },
    }),
    async (c) => c.json(await boardChart(deps.db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/buttons/{columnId}',
      tags: ['items'],
      summary: "Click a button column: runs the column's action and fires `button.clicked` for automations",
      middleware,
      request: {
        headers: accountHeader,
        params: idParam.extend({ columnId: z.string().openapi({ param: { name: 'columnId', in: 'path' } }) }),
        // A popup button's answers; other buttons send nothing.
        body: { content: { 'application/json': { schema: buttonClickSchema } }, required: false },
      },
      responses: { 200: json(buttonResultSchema, 'Clicked'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      const raw = await c.req.json().catch(() => ({}));
      const parsed = buttonClickSchema.safeParse(raw ?? {});
      if (!parsed.success) throw new AppError('validation_failed', 'Invalid body', { issues: parsed.error.issues });
      return c.json(await clickButton(deps, actorOf(c), p.id, p.columnId, parsed.data), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/items/{id}/buttons/{columnId}/linked',
      tags: ['items'],
      summary: 'A "create a linked item" button: the linked item its popup fills in (its reuse rule), or null',
      middleware,
      request: {
        headers: accountHeader,
        params: idParam.extend({ columnId: z.string().openapi({ param: { name: 'columnId', in: 'path' } }) }),
      },
      responses: {
        200: json(
          z.object({
            item_id: z.string().nullable(),
            name: z.string(),
            cells: z.record(
              z.string(),
              z.object({ value: z.unknown(), text: z.string().nullable(), names: z.array(z.string()).optional() }),
            ),
          }),
          'The linked item, or the first values of a new one',
        ),
        ...common,
      },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await linkedForButton(deps, actorOf(c), p.id, p.columnId), 200);
    },
  );
  return r;
};
