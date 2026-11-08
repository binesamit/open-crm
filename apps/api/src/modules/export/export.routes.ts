// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { exportRequestSchema } from '@bines/shared';
import { currentUser, requireAccount } from '../../middleware/auth';
import { accountHeader, errors, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { contentDisposition, exportBoard } from './export.service';

const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });

/** Board export to Excel / CSV (M6 stage 8). */
export const exportRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/export',
      tags: ['items'],
      summary: "Download the board (the view's query and columns, or a selection) as .xlsx or .csv",
      middleware: [requireAccount(deps)],
      request: { headers: accountHeader, params: boardParam, ...jsonBody(exportRequestSchema) },
      responses: {
        200: {
          description: 'The file',
          content: {
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: z.string() },
            'text/csv': { schema: z.string() },
          },
        },
        ...errors(400, 401, 403, 404, 422),
      },
    }),
    async (c) => {
      const file = await exportBoard(
        deps.db,
        { ctx: c.get('account'), user: currentUser(c), requestId: c.get('requestId') },
        c.req.valid('param').boardId,
        c.req.valid('json'),
      );
      return new Response(new Uint8Array(file.body), {
        status: 200,
        headers: { 'content-type': file.type, 'content-disposition': contentDisposition(file.name) },
      }) as never;
    },
  );
  return r;
};
