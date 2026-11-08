// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  bulkItemsSchema,
  bulkResultSchema,
  createItemSchema,
  convertItemSchema,
  createSubitemSchema,
  movedSchema,
  moveToBoardSchema,
  duplicateItemSchema,
  itemSchema,
  itemsPageSchema,
  itemsQueryRequestSchema,
  moveItemToGroupSchema,
  setCellSchema,
  updateItemSchema,
  deletedSchema,
  editedItemSchema,
  positionSchema,
  reorderSubitemSchema,
  voteSchema,
  AppError,
  BULK_QUERY_MAX,
  bulkQuerySchema,
  outlineRequestSchema,
  outlineSchema,
  WINDOW_MIN_ITEMS,
  windowedInfoSchema,
  itemSearchResultSchema,
  relationMatchesSchema,
  itemFormatQuerySchema,
  rulesToFilter,
} from '@bines/shared';
import {
  cellsFromPlainValues,
  flatIf,
  flatListIf,
  itemBoardOf,
  subitemBoardOf,
} from '../integrations/integrations.service';
import { relationChoiceSearch, relationMatches } from './relation-filter.service';
import { boardOutline, bulkByQuery, windowInfo } from './window.service';
import { currentUser, requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, COMMON_ERRORS } from '../../lib/openapi';
import { RateLimiter, rateLimit } from '../../lib/rate-limit';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './items.service';
import { parseQueryParam, queryItems } from './query.service';
import { bulkItems } from './bulk.service';
import { createSubitem, reorderSubitem, reparentSubitem } from './subitems.service';
import { duplicateItem } from './duplicate.service';
import { setVote } from './vote.service';
import { convertItem, moveItemToBoard } from './move.service';
import { outdentItem } from './hierarchy.service';
import { ITEM_COLUMN_ID_MAX, ITEM_COLUMNS_MAX, parseColumnsParam, selectCells } from './columns-param';

/** `GET /boards/:id/items?ids=` — the rows one live refresh may ask for. */
const ITEM_IDS_MAX = 200;
const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });
const cellParams = idParam.extend({ columnId: z.string().openapi({ param: { name: 'columnId', in: 'path' } }) });
const qParam = z.object({
  q: z.string().max(20_000).optional().openapi({ description: 'base64url JSON of a Query (13-FILTERS §1)' }),
});

/** Items and cells (06 §2.9, §2.11). Cell values follow each type's valueSchema (03-COLUMN-TYPES). */
export const itemRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  // Live counts for quick filters: 10 requests a second per user (13-FILTERS).
  const countLimiter = new RateLimiter(10, 1000);
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/items',
      tags: ['items'],
      summary: 'All items of a board with their cells (keyed by column id); `q` filters and sorts them',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: boardParam,
        query: qParam.extend({
          window: z
            .enum(['1'])
            .optional()
            .openapi({
              description: `Windowed loading (perf review §7.1): a top-level board with more than \`window_min\` (default ${WINDOW_MIN_ITEMS}) items answers with \`windowed\` and no rows — the client then works from \`items/outline\``,
            }),
          window_min: z.coerce.number().int().min(0).max(1_000_000).optional(),
          ids: z
            .string()
            .max(ITEM_IDS_MAX * 27)
            .optional()
            .openapi({
              description: `Comma-separated item ids (at most ${ITEM_IDS_MAX}): only these items — ids that are gone, elsewhere or hidden are left out`,
            }),
          columns: z
            .string()
            .max(ITEM_COLUMNS_MAX * (ITEM_COLUMN_ID_MAX + 1))
            .optional()
            .openapi({
              description: `Field selection: comma-separated column ids (at most ${ITEM_COLUMNS_MAX}, each at most ${ITEM_COLUMN_ID_MAX} characters) — each item's \`cells\` holds only these columns; the item's own fields (id, name, group, dates…) always come. Ids the board does not have, or that the caller may not see, are left out (never an error). Empty (\`columns=\`) → no cells.`,
              example: 'status,owner,due',
            }),
        }),
      },
      responses: {
        200: json(z.object({ data: z.array(itemSchema), windowed: windowedInfoSchema.optional() }), 'Items'),
        ...COMMON_ERRORS,
      },
    }),
    async (c) => {
      const boardId = c.req.valid('param').boardId;
      const { q, ids, window, window_min, columns: rawColumns } = c.req.valid('query');
      const columns = parseColumnsParam(rawColumns);
      // Field selection runs on what the services return — cells already filtered by the caller's permissions.
      const pick = <T extends { cells: Record<string, unknown> }>(rows: T[]): T[] =>
        columns ? rows.map((row) => ({ ...row, cells: selectCells(row.cells, columns) })) : rows;
      if (window && ids === undefined && !q) {
        const windowed = await windowInfo(db, actorOf(c), boardId, window_min ?? WINDOW_MIN_ITEMS);
        if (windowed) return c.json({ data: [], windowed }, 200);
      }
      if (ids !== undefined) {
        const list = [...new Set(ids.split(',').filter(Boolean))];
        if (list.length > ITEM_IDS_MAX) throw new AppError('validation_failed', `At most ${ITEM_IDS_MAX} ids`);
        return c.json({ data: pick(await svc.listItems(db, actorOf(c), boardId, list)) }, 200);
      }
      const query = parseQueryParam(q);
      if (!query) return c.json({ data: pick(await svc.listItems(db, actorOf(c), boardId)) }, 200);
      return c.json({ data: pick((await queryItems(db, actorOf(c), boardId, query, { limit: null })).data) }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/items/query',
      tags: ['items'],
      summary: 'Query items: nested AND/OR/NOT filter, search, person, sort (13-FILTERS); cursor paging',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: boardParam,
        query: itemFormatQuerySchema,
        ...jsonBody(itemsQueryRequestSchema),
      },
      responses: { 200: json(itemsPageSchema, 'One page of matches'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const { cursor, limit, rules, ...rest } = c.req.valid('json');
      // Flat rules (integrations) are ANDed with the filter tree.
      const query = rules?.length
        ? {
            ...rest,
            filter: rest.filter
              ? {
                  kind: 'group' as const,
                  operator: 'and' as const,
                  negate: false,
                  rules: [rest.filter, rulesToFilter(rules)],
                }
              : rulesToFilter(rules),
          }
        : rest;
      const page = await queryItems(db, actorOf(c), c.req.valid('param').boardId, query, { cursor, limit });
      return c.json({ ...page, data: await flatListIf(db, c.req.valid('query').format, page.data) }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/items/count',
      tags: ['items'],
      summary: 'Number of items matching `q` (live counts; 10 requests a second per user)',
      middleware: [...scoped, rateLimit(countLimiter, (c) => currentUser(c).id)],
      request: { headers: accountHeader, params: boardParam, query: qParam },
      responses: { 200: json(z.object({ count: z.number().int() }), 'Count'), ...COMMON_ERRORS, ...errors(429) },
    }),
    async (c) => {
      const query = parseQueryParam(c.req.valid('query').q) ?? itemsQueryRequestSchema.parse({});
      const res = await queryItems(db, actorOf(c), c.req.valid('param').boardId, query, {
        limit: null,
        countOnly: true,
      });
      return c.json({ count: res.total }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/items/search',
      tags: ['items'],
      summary:
        "Items of a board by name (relation picker); with `source_board_id` + `column_id` only the items the relation column's filter offers",
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: boardParam,
        query: z.object({
          q: z.string().max(100).default(''),
          source_board_id: z.string().max(40).optional(),
          column_id: z.string().max(64).optional(),
          offset: z.coerce.number().int().min(0).max(100_000).default(0),
          /**
           * With `source_board_id` + `column_id`: only these items (comma-separated, up to 30) — which of them the
           * column's filter offers (the form editor's warning, r19relfilter).
           */
          ids: z
            .string()
            .max(1500)
            .optional()
            .transform((v) => (v ? [...new Set(v.split(',').filter(Boolean))].slice(0, 30) : undefined)),
        }),
      },
      responses: { 200: json(itemSearchResultSchema, 'Items'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const boardId = c.req.valid('param').boardId;
      const { q, source_board_id, column_id, offset, ids } = c.req.valid('query');
      if (source_board_id && column_id) {
        const filtered = await relationChoiceSearch(db, actorOf(c), boardId, q, {
          boardId: source_board_id,
          columnKey: column_id,
          offset,
          ids,
        });
        if (filtered) return c.json(filtered, 200);
      }
      return c.json({ ...(await svc.searchItems(db, actorOf(c), boardId, q, offset)), filter: null }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/columns/{columnId}/relation-matches',
      tags: ['items'],
      summary:
        "A relation column's filters and the linked items that no longer match them, for the viewer (the warning marks)",
      middleware: scoped,
      request: { headers: accountHeader, params: z.object({ boardId: z.string(), columnId: z.string() }) },
      responses: { 200: json(relationMatchesSchema, 'Matches'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const { boardId, columnId } = c.req.valid('param');
      return c.json(await relationMatches(db, actorOf(c), boardId, columnId), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/columns/{columnId}/values',
      tags: ['items'],
      summary: 'Existing values of a column, most used first (text suggestions, 03 §2.2)',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: z.object({ boardId: z.string(), columnId: z.string() }),
        query: z.object({ q: z.string().max(100).default('') }),
      },
      responses: {
        200: json(z.object({ data: z.array(z.object({ value: z.string(), count: z.number() })) }), 'Values'),
        ...COMMON_ERRORS,
      },
    }),
    async (c) => {
      const { boardId, columnId } = c.req.valid('param');
      return c.json({ data: await svc.columnValues(db, actorOf(c), boardId, columnId, c.req.valid('query').q) }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/items',
      tags: ['items'],
      summary: 'Create an item (optionally with cells)',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: boardParam,
        query: itemFormatQuerySchema,
        ...jsonBody(createItemSchema),
      },
      responses: { 201: json(itemSchema, 'Created'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const boardId = c.req.valid('param').boardId;
      const { values, ...input } = c.req.valid('json');
      const cells = { ...input.cells, ...(await cellsFromPlainValues(deps, actorOf(c), boardId, values)) };
      const item = await svc.createItem(db, actorOf(c), boardId, { ...input, cells });
      return c.json(await flatIf(db, c.req.valid('query').format, item), 201);
    },
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/items/{id}',
      tags: ['items'],
      summary: 'Rename and/or set several cells in one batch (null clears)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, query: itemFormatQuerySchema, ...jsonBody(updateItemSchema) },
      responses: { 200: json(editedItemSchema, 'Item (with the edit event)'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const id = c.req.valid('param').id;
      const { values, ...input } = c.req.valid('json');
      const plain =
        values && Object.keys(values).length
          ? await cellsFromPlainValues(deps, actorOf(c), await itemBoardOf(db, actorOf(c), id), values)
          : {};
      const cells = input.cells || Object.keys(plain).length ? { ...input.cells, ...plain } : undefined;
      const item = await svc.updateItem(db, actorOf(c), id, { ...input, ...(cells ? { cells } : {}) });
      return c.json(await flatIf(db, c.req.valid('query').format, item), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/items/{id}/cells/{columnId}',
      tags: ['items'],
      summary: 'Set one cell',
      middleware: scoped,
      request: { headers: accountHeader, params: cellParams, ...jsonBody(setCellSchema) },
      responses: { 200: json(editedItemSchema, 'Item (with the edit event)'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      const body = c.req.valid('json');
      return c.json(
        await svc.setCell(db, actorOf(c), p.id, p.columnId, body.value ?? null, {
          ...(body.workflow_override ? { workflow_override: true } : {}),
        }),
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/items/{id}/cells/{columnId}',
      tags: ['items'],
      summary: 'Clear one cell',
      middleware: scoped,
      request: { headers: accountHeader, params: cellParams },
      responses: { 200: json(editedItemSchema, 'Item (with the edit event)'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.setCell(db, actorOf(c), p.id, p.columnId, null), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/cells/{columnId}/vote',
      tags: ['items'],
      summary: 'Cast or take back my vote on a vote column',
      middleware: scoped,
      request: { headers: accountHeader, params: cellParams, ...jsonBody(voteSchema) },
      responses: { 200: json(editedItemSchema, 'Item'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await setVote(db, actorOf(c), p.id, p.columnId, c.req.valid('json').vote), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/move-to-board',
      tags: ['items'],
      summary: 'Move an item (with its subitems) to another board; cells follow the column mapping',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(moveToBoardSchema) },
      responses: { 200: json(movedSchema, 'Moved'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await moveItemToBoard(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/convert',
      tags: ['items'],
      summary: 'Item → subitem of parent_item_id, or subitem → item in group_id (cells follow the mapping)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(convertItemSchema) },
      responses: { 200: json(movedSchema, 'Converted'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await convertItem(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/outdent',
      tags: ['items'],
      summary: 'A subitem one level up: under its grandparent (after its parent), or an item after its parent',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(movedSchema, 'Moved up'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await outdentItem(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/duplicate',
      tags: ['items'],
      summary: 'Duplicate an item right below it (subitems too; updates with with_updates)',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: idParam,
        query: itemFormatQuerySchema,
        ...jsonBody(duplicateItemSchema),
      },
      responses: { 201: json(itemSchema, 'The copy'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const copy = await duplicateItem(db, actorOf(c), c.req.valid('param').id, c.req.valid('json').with_updates);
      return c.json(await flatIf(db, c.req.valid('query').format, copy), 201);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/subitems',
      tags: ['items'],
      summary: "Add a subitem (D14): it lives on the board's sub-board, created with default columns on first use",
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: idParam,
        query: itemFormatQuerySchema,
        ...jsonBody(createSubitemSchema),
      },
      responses: { 201: json(itemSchema, 'Subitem'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const parentId = c.req.valid('param').id;
      const { values, ...input } = c.req.valid('json');
      const plain =
        values && Object.keys(values).length
          ? await cellsFromPlainValues(deps, actorOf(c), await subitemBoardOf(db, actorOf(c), parentId), values)
          : {};
      const sub = await createSubitem(db, actorOf(c), parentId, { ...input, cells: { ...input.cells, ...plain } });
      return c.json(await flatIf(db, c.req.valid('query').format, sub), 201);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/reorder',
      tags: ['items'],
      summary: 'Move a subitem among its siblings (drag in the subitems table)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(reorderSubitemSchema) },
      responses: { 200: json(editedItemSchema, 'Subitem (with the move event)'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await reorderSubitem(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/reparent',
      tags: ['items'],
      summary: 'Move a subitem (with its own subitems) under another item or subitem of the board, at a position',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: idParam,
        ...jsonBody(z.object({ parent_item_id: z.string(), position: positionSchema })),
      },
      responses: { 200: json(movedSchema, 'Moved'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await reparentSubitem(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/items/bulk',
      tags: ['items'],
      summary: 'Batch action on up to 5,000 items (one batch_id; skipped items counted; undo the summary event)',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(bulkItemsSchema) },
      responses: { 200: json(bulkResultSchema, 'Done'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await bulkItems(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/items/bulk-query',
      tags: ['items'],
      summary: `Batch action on every item matching a query (up to ${BULK_QUERY_MAX}; a windowed board's "select all")`,
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(bulkQuerySchema) },
      responses: { 200: json(bulkResultSchema, 'Done'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await bulkByQuery(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/items/outline',
      tags: ['items'],
      summary:
        'Outline of a view over a big board: matching ids per section in view order, with footer summaries (windowed loading)',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(outlineRequestSchema) },
      responses: { 200: json(outlineSchema, 'Outline'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await boardOutline(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/move-to-group',
      tags: ['items'],
      summary: 'Move (or reorder) an item within its board',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: idParam,
        query: itemFormatQuerySchema,
        ...jsonBody(moveItemToGroupSchema),
      },
      responses: { 200: json(editedItemSchema, 'Item (with the move event)'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const body = c.req.valid('json');
      const moved = await svc.moveItemToGroup(
        db,
        actorOf(c),
        c.req.valid('param').id,
        body.group_id,
        body.position,
        body.between,
      );
      return c.json(await flatIf(db, c.req.valid('query').format, moved), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/items/{id}',
      tags: ['items'],
      summary: 'Move an item to trash',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(deletedSchema, 'Deleted'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const event_id = await svc.deleteItem(db, actorOf(c), c.req.valid('param').id);
      return c.json({ ok: true as const, event_id }, 200);
    },
  );

  return r;
};
