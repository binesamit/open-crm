// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  boardDetailSchema,
  columnSchema,
  createBoardSchema,
  createColumnSchema,
  createFolderSchema,
  createGroupSchema,
  createWorkspaceSchema,
  folderSchema,
  groupSchema,
  reorderSchema,
  templateSummarySchema,
  updateBoardSchema,
  updateColumnSchema,
  updateFolderSchema,
  updateGroupSchema,
  updateWorkspaceSchema,
  workspaceSchema,
  workspaceTreeSchema,
  deletedSchema,
  duplicateBoardSchema,
  duplicateGroupSchema,
  saveAsTemplateSchema,
  updateTemplateSchema,
  movedSchema,
  moveGroupToBoardSchema,
  setTwoWaySchema,
  twoWayResultSchema,
  itemSequenceOutSchema,
  updateItemSequenceSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { currentUser, requestMeta, requireAccount } from '../../middleware/auth';
import { accountHeader, idParam, json, jsonBody, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './boards.service';
import { duplicateGroup } from '../items/duplicate.service';
import { moveGroupToBoard } from '../items/move.service';
import { duplicateBoard, saveAsTemplate } from './board-copy.service';
import { setTwoWay } from './two-way.service';
import { listWorkflowVersions, workflowVersion } from './workflow-versions';
import { getItemSequence, updateItemSequence } from './item-keys.service';

const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });
const groupParams = boardParam.extend({ groupId: z.string().openapi({ param: { name: 'groupId', in: 'path' } }) });
const columnParams = boardParam.extend({ columnId: z.string().openapi({ param: { name: 'columnId', in: 'path' } }) });
// The workspace page (account admin plan): a workspace carries a free-text description.
const workspaceOut = workspaceSchema.extend({ description: z.string().nullable() });
const workspaceTreeOut = workspaceTreeSchema.extend({
  workspace: workspaceTreeSchema.shape.workspace.extend({ description: z.string().nullable() }),
});
const updateWorkspaceIn = updateWorkspaceSchema.extend({
  description: z.string().max(2000).nullable().optional(),
});

/** Structure: workspaces, folders, templates, boards, groups, columns (06 §2.4–2.8). All account-scoped (D12). */
export const boardRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  // The session / token: a secret column's settings change asks for the two-factor step-up.
  const actor = (c: Context<AppEnv>) => ({
    ctx: c.get('account'),
    user: currentUser(c),
    requestId: c.get('requestId'),
    sessionId: c.get('sessionId') ?? null,
    token: c.get('token') ?? null,
    meta: requestMeta(c),
  });
  const r = new OpenAPIHono<AppEnv>();
  const deleted = { 200: json(deletedSchema, 'Moved to trash'), ...COMMON_ERRORS };

  // ---- workspaces & folders ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/workspaces',
      tags: ['workspaces'],
      summary: 'Workspaces visible to me',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(workspaceOut) }), 'Workspaces'), ...COMMON_ERRORS },
    }),
    async (c) => c.json({ data: await svc.listVisibleWorkspaces(db, actor(c)) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/workspaces',
      tags: ['workspaces'],
      summary: 'Create a workspace',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(createWorkspaceSchema) },
      responses: { 201: json(workspaceOut, 'Created'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.createWorkspace(db, actor(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/workspaces/{id}',
      tags: ['workspaces'],
      summary: 'Rename a workspace, change its kind or its description',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateWorkspaceIn) },
      responses: { 200: json(workspaceOut, 'Updated'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.updateWorkspace(db, actor(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/workspaces/{id}',
      tags: ['workspaces'],
      summary: 'Delete an empty workspace (admins; never the last one)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: deleted,
    }),
    async (c) => {
      const event_id = await svc.deleteWorkspace(db, actor(c), c.req.valid('param').id);
      return c.json({ ok: true as const, event_id }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/workspaces/{id}/tree',
      tags: ['workspaces'],
      summary: 'Sidebar: folders and the boards I can see',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(workspaceTreeOut, 'Tree'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.workspaceTree(db, actor(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/folders',
      tags: ['folders'],
      summary: 'Create a folder (≤3 levels)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(createFolderSchema) },
      responses: { 201: json(folderSchema, 'Created'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.createFolder(db, actor(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/folders/{id}',
      tags: ['folders'],
      summary: 'Rename / recolour a folder',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateFolderSchema) },
      responses: { 200: json(folderSchema, 'Updated'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.updateFolder(db, actor(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/folders/{id}',
      tags: ['folders'],
      summary: 'Move a folder and its sub-folders to trash; their boards move to the root (or to trash with it)',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: idParam,
        query: z.object({
          boards: z
            .enum(['root', 'trash'])
            .optional()
            .openapi({ description: 'root (default): its boards move to the root; trash: they go to trash with it' }),
        }),
      },
      responses: deleted,
    }),
    async (c) => {
      const event_id = await svc.deleteFolder(db, actor(c), c.req.valid('param').id, {
        boards: c.req.valid('query').boards,
      });
      return c.json({ ok: true as const, event_id }, 200);
    },
  );

  // ---- templates & boards ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/templates',
      tags: ['boards'],
      summary: 'Built-in board templates',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(templateSummarySchema) }), 'Templates'), ...COMMON_ERRORS },
    }),
    async (c) => c.json({ data: await svc.listTemplates(db, actor(c)) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/templates/{key}',
      tags: ['boards'],
      summary: "Rename / redescribe one of the account's templates (its creator or an admin)",
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: z.object({ key: z.string().openapi({ param: { name: 'key', in: 'path' } }) }),
        ...jsonBody(updateTemplateSchema),
      },
      responses: { 200: json(templateSummarySchema, 'Template'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.updateTemplate(db, actor(c), c.req.valid('param').key, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/templates/{key}',
      tags: ['boards'],
      summary: "Delete one of the account's templates (boards made from it stay)",
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: z.object({ key: z.string().openapi({ param: { name: 'key', in: 'path' } }) }),
      },
      responses: { 200: json(z.object({ ok: z.literal(true) }), 'Deleted'), ...COMMON_ERRORS },
    }),
    async (c) => {
      await svc.deleteTemplate(db, actor(c), c.req.valid('param').key);
      return c.json({ ok: true as const }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards',
      tags: ['boards'],
      summary: 'Create a board (empty or from a template); the creator becomes owner',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(createBoardSchema) },
      responses: { 201: json(boardDetailSchema, 'Created'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.createBoard(db, actor(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}',
      tags: ['boards'],
      summary: 'Board with columns, groups and my capabilities',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: { 200: json(boardDetailSchema, 'Board'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.getBoard(db, actor(c), c.req.valid('param').boardId), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/boards/{boardId}',
      tags: ['boards'],
      summary: 'Rename / describe / permission set (owner or admin)',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(updateBoardSchema) },
      responses: { 200: json(boardDetailSchema, 'Board'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.updateBoard(db, actor(c), c.req.valid('param').boardId, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/boards/{boardId}',
      tags: ['boards'],
      summary: 'Move a board to trash (owner or admin)',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: deleted,
    }),
    async (c) => {
      const event_id = await svc.deleteBoard(db, actor(c), c.req.valid('param').boardId);
      return c.json({ ok: true as const, event_id }, 200);
    },
  );

  // ---- groups ----
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/groups',
      tags: ['groups'],
      summary: 'Add a group (top by default)',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(createGroupSchema) },
      responses: { 201: json(groupSchema, 'Created'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.createGroup(db, actor(c), c.req.valid('param').boardId, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/boards/{boardId}/groups/{groupId}',
      tags: ['groups'],
      summary: 'Rename / recolour a group',
      middleware: scoped,
      request: { headers: accountHeader, params: groupParams, ...jsonBody(updateGroupSchema) },
      responses: { 200: json(groupSchema, 'Updated'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.updateGroup(db, actor(c), p.boardId, p.groupId, c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/groups/{groupId}/reorder',
      tags: ['groups'],
      summary: 'Move a group',
      middleware: scoped,
      request: { headers: accountHeader, params: groupParams, ...jsonBody(reorderSchema) },
      responses: { 200: json(groupSchema, 'Moved'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.reorderGroup(db, actor(c), p.boardId, p.groupId, c.req.valid('json').position), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/duplicate',
      tags: ['boards'],
      summary: 'Duplicate a board: structure, + items, or + items and updates (the duplicator owns the copy)',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(duplicateBoardSchema) },
      responses: { 201: json(boardDetailSchema, 'The copy'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const a = actor(c);
      const id = await duplicateBoard(db, a, c.req.valid('param').boardId, c.req.valid('json'));
      return c.json(await svc.getBoard(db, a, id), 201);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/save-as-template',
      tags: ['boards'],
      summary: "Save the board's structure as a template of this account (owners / admins)",
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(saveAsTemplateSchema) },
      responses: { 201: json(z.object({ key: z.string(), name: z.string() }), 'Template'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await saveAsTemplate(db, actor(c), c.req.valid('param').boardId, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/groups/{groupId}/move-to-board',
      tags: ['groups'],
      summary: 'Move a group (same id) and its items to another board, one batch',
      middleware: scoped,
      request: { headers: accountHeader, params: groupParams, ...jsonBody(moveGroupToBoardSchema) },
      responses: { 200: json(movedSchema, 'Moved'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await moveGroupToBoard(db, actor(c), p.boardId, p.groupId, c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/groups/{groupId}/duplicate',
      tags: ['groups'],
      summary: 'Duplicate a group right below it (with its items unless with_items is false)',
      middleware: scoped,
      request: { headers: accountHeader, params: groupParams, ...jsonBody(duplicateGroupSchema) },
      responses: { 201: json(groupSchema, 'The copy'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await duplicateGroup(db, actor(c), p.boardId, p.groupId, c.req.valid('json').with_items), 201);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/boards/{boardId}/groups/{groupId}',
      tags: ['groups'],
      summary: 'Move a group and its items to trash (not the last group)',
      middleware: scoped,
      request: { headers: accountHeader, params: groupParams },
      responses: deleted,
    }),
    async (c) => {
      const p = c.req.valid('param');
      const event_id = await svc.deleteGroup(db, actor(c), p.boardId, p.groupId);
      return c.json({ ok: true as const, event_id }, 200);
    },
  );

  // ---- columns (addressed by their board-scoped key) ----
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/columns',
      tags: ['columns'],
      summary: 'Add a column of a registry type',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(createColumnSchema) },
      responses: { 201: json(columnSchema, 'Created'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.createColumn(db, actor(c), c.req.valid('param').boardId, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/boards/{boardId}/columns/{columnId}',
      tags: ['columns'],
      summary:
        'Rename, resize or change settings (labels …). Changing a secret column’s settings needs a fresh 2FA code (a token: secrets:read)',
      middleware: scoped,
      request: { headers: accountHeader, params: columnParams, ...jsonBody(updateColumnSchema) },
      responses: { 200: json(columnSchema, 'Updated'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.updateColumn(db, actor(c), p.boardId, p.columnId, c.req.valid('json'), deps.env), 200);
    },
  );
  // a status column's workflow versions (each save is one) and putting one back.
  const workflowVersionOut = z.object({
    version: z.number().int(),
    workflow: z.record(z.string(), z.unknown()),
    created_by: z.string().nullable(),
    created_at: z.string(),
  });
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/columns/{columnId}/workflow-versions',
      tags: ['columns'],
      summary: "A status column's saved workflow versions, newest first",
      middleware: scoped,
      request: { headers: accountHeader, params: columnParams },
      responses: { 200: json(z.object({ versions: z.array(workflowVersionOut) }), 'Versions'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json({ versions: await listWorkflowVersions(db, actor(c), p.boardId, p.columnId) }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/columns/{columnId}/workflow-versions/{version}/restore',
      tags: ['columns'],
      summary: 'Put a saved workflow version back (saved as a new version; board owner or admin)',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: columnParams.extend({
          version: z.coerce
            .number()
            .int()
            .min(1)
            .openapi({ param: { name: 'version', in: 'path' } }),
        }),
      },
      responses: { 200: json(columnSchema, 'Updated'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      const { column, workflow } = await workflowVersion(db, actor(c), p.boardId, p.columnId, p.version);
      return c.json(
        await svc.updateColumn(db, actor(c), p.boardId, p.columnId, { settings: { ...column.settings, workflow } }),
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/boards/{boardId}/columns/{columnId}/two-way',
      tags: ['columns'],
      summary: 'Turn a relation column two-way (pair with a column on the target board) or back to one-way',
      middleware: scoped,
      request: { headers: accountHeader, params: columnParams, ...jsonBody(setTwoWaySchema) },
      responses: { 200: json(twoWayResultSchema, 'Updated'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await setTwoWay(db, actor(c), p.boardId, p.columnId, c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/columns/{columnId}/sequence',
      tags: ['columns'],
      summary: "An item-number column's sequence: prefix, padding, the next number",
      middleware: scoped,
      request: { headers: accountHeader, params: columnParams },
      responses: { 200: json(itemSequenceOutSchema, 'Sequence'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await getItemSequence(db, actor(c), p.boardId, p.columnId), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/boards/{boardId}/columns/{columnId}/sequence',
      tags: ['columns'],
      summary: 'Set the number the next item gets (continue numbering from another system)',
      middleware: scoped,
      request: { headers: accountHeader, params: columnParams, ...jsonBody(updateItemSequenceSchema) },
      responses: { 200: json(itemSequenceOutSchema, 'Updated'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await updateItemSequence(db, actor(c), p.boardId, p.columnId, c.req.valid('json').next_seq), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/columns/{columnId}/reorder',
      tags: ['columns'],
      summary: 'Move a column (the name column stays first)',
      middleware: scoped,
      request: { headers: accountHeader, params: columnParams, ...jsonBody(reorderSchema) },
      responses: { 200: json(columnSchema, 'Moved'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.reorderColumn(db, actor(c), p.boardId, p.columnId, c.req.valid('json').position), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/boards/{boardId}/columns/{columnId}',
      tags: ['columns'],
      summary: 'Move a column to trash; its id stays reserved',
      middleware: scoped,
      request: { headers: accountHeader, params: columnParams },
      responses: deleted,
    }),
    async (c) => {
      const p = c.req.valid('param');
      const event_id = await svc.deleteColumn(db, actor(c), p.boardId, p.columnId);
      return c.json({ ok: true as const, event_id }, 200);
    },
  );

  return r;
};
