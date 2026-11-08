// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  cellDocSchema,
  collabTokenSchema,
  createCellDocSchema,
  createDocSchema,
  createDocThreadSchema,
  createDocVersionSchema,
  deletedSchema,
  DOC_EXPORT_FORMATS,
  docCommentBodySchema,
  docContentSchema,
  docDetailSchema,
  docMembersSchema,
  docSummarySchema,
  docThreadSchema,
  docThreadsSchema,
  docVersionContentSchema,
  docVersionsSchema,
  duplicateDocSchema,
  favoriteDocsSchema,
  inviteToDocResultSchema,
  inviteToDocSchema,
  resolveDocThreadSchema,
  setDocMembersSchema,
  setFavoriteDocsSchema,
  updateDocSchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { contentDisposition } from '../export/export.service';
import { openCellDoc } from './docs.cell';
import * as comments from './docs.comments';
import { exportDoc } from './docs.export';
import { inviteToDoc } from './docs.invite';
import * as svc from './docs.service';
import * as versions from './docs.versions';

const cellParams = idParam.extend({ columnId: z.string().openapi({ param: { name: 'columnId', in: 'path' } }) });
const versionParams = idParam.extend({ versionId: z.string().openapi({ param: { name: 'versionId', in: 'path' } }) });

/** Docs (M8 ד1): CRUD, content without a WebSocket, members, favourites and the collab token. */
export const docRoutes = (deps: AppDeps) => {
  const { db, env } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/workspaces/{id}/docs',
      tags: ['docs'],
      summary: 'Docs of a workspace that I can open',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(z.object({ data: z.array(docSummarySchema) }), 'Docs'), ...COMMON_ERRORS },
    }),
    async (c) => c.json({ data: await svc.listWorkspaceDocs(db, actorOf(c), c.req.valid('param').id) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/workspaces/{id}/docs',
      tags: ['docs'],
      summary: 'Create a doc (members and admins); the creator owns it',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(createDocSchema) },
      responses: { 201: json(docDetailSchema, 'Created'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.createDoc(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/docs/{id}',
      tags: ['docs'],
      summary: 'A doc with my capabilities and its collab document name',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(docDetailSchema, 'Doc'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.getDoc(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/docs/{id}',
      tags: ['docs'],
      summary: 'Rename, icon, kind, folder / place / workspace, settings (owners and admins)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateDocSchema) },
      responses: { 200: json(docDetailSchema, 'Doc'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.updateDoc(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/docs/{id}',
      tags: ['docs'],
      summary: 'Move a doc to trash (owners and admins)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(deletedSchema, 'Moved to trash'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json({ ok: true as const, event_id: await svc.deleteDoc(db, actorOf(c), c.req.valid('param').id) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/docs/{id}/duplicate',
      tags: ['docs'],
      summary: 'Duplicate a doc right after it (its content as saved); I own the copy',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(duplicateDocSchema) },
      responses: { 201: json(docDetailSchema, 'The copy'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.duplicateDoc(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/docs/{id}/content',
      tags: ['docs'],
      summary: 'The doc as ProseMirror JSON + plain text (as last saved; no WebSocket needed)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(docContentSchema, 'Content'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.getDocContent(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/docs/{id}/members',
      tags: ['docs'],
      summary: 'People and teams invited to the doc, with their level',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(docMembersSchema, 'Members'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.getDocMembers(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/docs/{id}/members',
      tags: ['docs'],
      summary: 'Replace the members (owners and admins); a doc keeps a person who owns it',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(setDocMembersSchema) },
      responses: { 200: json(docMembersSchema, 'Members'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.setDocMembers(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/docs/{id}/collab-token',
      tags: ['docs'],
      summary: "A 5-minute token to open the doc's WebSocket without the session cookie",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(collabTokenSchema, 'Token'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(await svc.issueCollabToken(db, actorOf(c), c.req.valid('param').id, env.BETTER_AUTH_SECRET), 200),
  );

  // ---- ד2: a doc in a cell ----
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/cells/{columnId}/doc',
      tags: ['docs'],
      summary: "The doc of an item's doc cell — made on first use (whoever may change the cell)",
      description: 'Later calls return the same doc (`created: false`). The doc has the item’s permissions.',
      middleware: scoped,
      request: { headers: accountHeader, params: cellParams, ...jsonBody(createCellDocSchema) },
      responses: { 200: json(cellDocSchema, 'The cell doc'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await openCellDoc(db, actorOf(c), p.id, p.columnId, c.req.valid('json')), 200);
    },
  );

  // ---- ד3: versions ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/docs/{id}/versions',
      tags: ['docs'],
      summary: 'Versions of a doc, newest first (automatic and named)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(docVersionsSchema, 'Versions'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await versions.listVersions(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/docs/{id}/versions',
      tags: ['docs'],
      summary: 'Save a named version of the doc as it is now (whoever edits)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(createDocVersionSchema) },
      responses: { 201: json(docVersionContentSchema, 'Saved'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(await versions.createVersion(db, actorOf(c), c.req.valid('param').id, c.req.valid('json').label), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/docs/{id}/versions/{versionId}',
      tags: ['docs'],
      summary: "A version's content (preview)",
      middleware: scoped,
      request: { headers: accountHeader, params: versionParams },
      responses: { 200: json(docVersionContentSchema, 'Version'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await versions.getVersion(db, actorOf(c), p.id, p.versionId), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/docs/{id}/versions/{versionId}/restore',
      tags: ['docs'],
      summary: 'Restore a version: its content becomes the doc’s, recorded as a new version (history is kept)',
      middleware: scoped,
      request: { headers: accountHeader, params: versionParams },
      responses: { 200: json(docVersionContentSchema, 'The new version'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await versions.restoreVersion(db, actorOf(c), p.id, p.versionId), 200);
    },
  );

  // ---- ד3: comments ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/docs/{id}/comments',
      tags: ['docs'],
      summary: 'Comment threads of a doc (each on a block), with their comments',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(docThreadsSchema, 'Threads'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await comments.listDocThreads(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/docs/{id}/comments',
      tags: ['docs'],
      summary: 'Start a comment thread on a block (owners, editors, commenters)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(createDocThreadSchema) },
      responses: { 201: json(docThreadSchema, 'Thread'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(await comments.createDocThread(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/doc-comment-threads/{id}/comments',
      tags: ['docs'],
      summary: 'Reply in a thread (reopens it when resolved)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(docCommentBodySchema) },
      responses: { 201: json(docThreadSchema, 'Thread'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(await comments.replyToThread(db, actorOf(c), c.req.valid('param').id, c.req.valid('json').body), 201),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/doc-comment-threads/{id}/resolve',
      tags: ['docs'],
      summary: 'Resolve (`resolved: true`) or reopen a thread',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(resolveDocThreadSchema) },
      responses: { 200: json(docThreadSchema, 'Thread'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(
        await comments.resolveDocThread(db, actorOf(c), c.req.valid('param').id, c.req.valid('json').resolved),
        200,
      ),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/doc-comments/{id}',
      tags: ['docs'],
      summary: 'Edit my comment',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(docCommentBodySchema) },
      responses: { 200: json(docThreadSchema, 'Thread'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(await comments.editDocComment(db, actorOf(c), c.req.valid('param').id, c.req.valid('json').body), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/doc-comments/{id}',
      tags: ['docs'],
      summary: 'Delete a comment (its author, or whoever manages the doc)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(docThreadsSchema, 'Threads'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await comments.deleteDocComment(db, actorOf(c), c.req.valid('param').id), 200),
  );

  // ---- ד3: export, invite ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/docs/{id}/export',
      tags: ['docs'],
      summary: 'Export the doc as HTML, Markdown, or a page to print to PDF',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, query: z.object({ format: z.enum(DOC_EXPORT_FORMATS) }) },
      responses: {
        200: {
          description: 'The file',
          content: { 'text/html': { schema: z.string() }, 'text/markdown': { schema: z.string() } },
        },
        ...COMMON_ERRORS,
      },
    }),
    async (c) => {
      const file = await exportDoc(deps, actorOf(c), c.req.valid('param').id, c.req.valid('query').format);
      return new Response(file.body, {
        status: 200,
        headers: {
          'content-type': file.type,
          'content-disposition': file.inline ? 'inline' : contentDisposition(file.name),
          // Our own sanitized page: no scripts, its own styles and images only.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:",
        },
      }) as never;
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/docs/{id}/invite',
      tags: ['docs'],
      summary: 'Share by email: people in the account join now, new people (guests too) get an invitation',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(inviteToDocSchema) },
      responses: { 200: json(inviteToDocResultSchema, 'Result'), ...errors(400, 401, 403, 404, 409, 422, 423, 429) },
    }),
    async (c) => c.json(await inviteToDoc(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  // ---- favourites ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/favorite-docs',
      tags: ['me'],
      summary: 'My favourite docs in this account, in my order (only docs I can still open)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(favoriteDocsSchema, 'Favourite docs'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await svc.favoriteDocs(db, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/me/favorite-docs',
      tags: ['me'],
      summary: 'Replace my favourite docs (the whole list, in order)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(setFavoriteDocsSchema) },
      responses: { 200: json(favoriteDocsSchema, 'Favourite docs'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await svc.setFavoriteDocs(db, actorOf(c), c.req.valid('json').doc_ids), 200),
  );

  return r;
};
