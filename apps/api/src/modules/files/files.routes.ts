// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { Readable } from 'node:stream';
import { contentDisposition } from '../export/export.service';
import { addCellLinkSchema, aiTool, cellLinkSchema, FILE_CELL_LINKS_MAX, updateCellLinkSchema } from '@bines/shared';
import { guardToolCall } from '../ai/tools/guard';
import { AI_EDIT_INSTRUCTION_MAX, aiEditFile, aiEditStatus } from './files.ai-edit';
import { addCellLink, removeCellLink, updateCellLink } from './files.links';
import * as svc from './files.service';
import { addFileVersion, deleteFileVersion, listFileVersions, makeVersionCurrent } from './files.versions';
import { cellFilesZip, type FilesZip, updateFilesZip } from './files.zip';

const common = errors(400, 401, 403, 404, 422, 423);
const tags = ['files'];
const fileSchema = z.object({ id: z.string(), name: z.string(), size: z.number(), mime: z.string() });
const fileVersionSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  name: z.string(),
  size: z.number(),
  mime: z.string(),
  created_by: z.object({ id: z.string(), name: z.string() }).nullable(),
  created_at: z.string(),
  current: z.boolean(),
});
const cellParams = idParam.extend({ columnId: z.string().openapi({ param: { name: 'columnId', in: 'path' } }) });

/** Files (06 §2.14): presign → PUT to storage → complete → attach to a cell or an update. */
export const fileRoutes = (deps: AppDeps) => {
  const middleware = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/files/presign',
      tags,
      summary: 'Start an upload: returns a presigned PUT URL (≤500 MB)',
      middleware,
      request: {
        headers: accountHeader,
        ...jsonBody(
          z.object({
            name: z.string().min(1).max(255),
            size: z.number().int().positive(),
            mime: z.string().max(127).default('application/octet-stream'),
          }),
        ),
      },
      responses: {
        200: json(
          z.object({
            file_id: z.string(),
            upload_url: z.string(),
            method: z.literal('PUT'),
            headers: z.record(z.string(), z.string()),
          }),
          'Presigned',
        ),
        ...errors(400, 401, 403, 404, 413, 423),
      },
    }),
    async (c) => c.json(await svc.presignUpload(deps, actorOf(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/files/{id}/complete',
      tags,
      summary: 'Finish an upload (the server checks the object exists)',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(fileSchema, 'File'), ...common },
    }),
    async (c) => c.json(await svc.completeUpload(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/files/{id}',
      tags,
      summary: 'File metadata + a 15-minute download link (access through its item)',
      description:
        '`inline=1`: the link opens the file in the browser (the viewer) instead of downloading it. A file id ' +
        'serves its current version; `exact=1` serves the file itself — its version 1.',
      middleware,
      request: {
        headers: accountHeader,
        params: idParam,
        query: z.object({ inline: z.enum(['0', '1']).optional(), exact: z.enum(['0', '1']).optional() }),
      },
      responses: {
        200: json(fileSchema.extend({ version: z.number().int(), download_url: z.string() }), 'File'),
        ...common,
      },
    }),
    async (c) =>
      c.json(
        await svc.getFile(deps, actorOf(c), c.req.valid('param').id, {
          inline: c.req.valid('query').inline === '1',
          exact: c.req.valid('query').exact === '1',
        }),
        200,
      ),
  );
  // --- versions: a file in a files column ----
  const versionParams = idParam.extend({
    versionId: z.string().openapi({ param: { name: 'versionId', in: 'path' } }),
  });
  r.openapi(
    createRoute({
      method: 'get',
      path: '/files/{id}/versions',
      tags,
      summary: "A file's versions, newest (the current one) first",
      description: 'For anyone who may read the file (as `GET /files/{id}`). `{id}` is the file (the id a cell holds).',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(z.object({ data: z.array(fileVersionSchema) }), 'Versions'), ...common },
    }),
    async (c) => c.json(await listFileVersions(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/files/{id}/versions',
      tags,
      summary: 'Upload a new version of a file in a files cell (it becomes current)',
      description:
        'Upload as usual (presign → PUT → complete), then send the new `file_id` here. The same rights as attaching ' +
        'to the cell; 409 `file_in_use` when that upload is already attached somewhere.',
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(z.object({ file_id: z.string() })) },
      responses: { 200: json(fileVersionSchema, 'The new version'), ...errors(400, 401, 403, 404, 409, 422, 423) },
    }),
    async (c) =>
      c.json(await addFileVersion(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json').file_id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/files/{id}/versions/{versionId}/make-current',
      tags,
      summary: 'Make an older version current again (copied as a new version)',
      middleware,
      request: { headers: accountHeader, params: versionParams },
      responses: { 200: json(fileVersionSchema, 'The new current version'), ...errors(400, 401, 403, 404, 422, 423) },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await makeVersionCurrent(deps, actorOf(c), p.id, p.versionId), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/files/{id}/versions/{versionId}',
      tags,
      summary: 'Delete a version that is not current (at once, not to the trash)',
      description:
        'Its uploader or a board owner / admin. 409 `version_is_current`; 409 `first_version_kept` for version 1 ' +
        'while newer versions exist (it anchors the file in its cell).',
      middleware,
      request: { headers: accountHeader, params: versionParams },
      responses: { 200: json(okSchema, 'Deleted'), ...errors(400, 401, 403, 404, 409, 423) },
    }),
    async (c) => {
      const p = c.req.valid('param');
      await deleteFileVersion(deps, actorOf(c), p.id, p.versionId);
      return c.json({ ok: true as const }, 200);
    },
  );
  // --- "Ask the AI for a change": an image in a files cell, the result as a new version ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/files/{id}/ai-edit',
      tags,
      summary: 'May I ask the AI for a change to this file now?',
      description:
        'For the file viewer: `available` when the caller may change the cell (as uploading a version), the ' +
        "account's AI is on and within budget, and the account has an image connection and model. Otherwise " +
        '`reason` says why (`role_ceiling` for a viewer, `ai_disabled`, `ai_budget_exceeded`, `ai_images_not_configured` …).',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: {
        200: json(z.object({ available: z.boolean(), reason: z.string().nullable() }), 'Status'),
        ...common,
      },
    }),
    async (c) => c.json(await aiEditStatus(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/files/{id}/ai-edit',
      tags,
      summary: 'Ask the AI for a change to an image; the result is saved as a new (current) version',
      description:
        "The account's image model (Administration → AI → images: its connection and model, both set) changes the " +
        'picture from `instruction`; the picture is `version_id` (an older version being viewed) or the current ' +
        'version. PNG / JPEG / WebP of at most 20 MB (422 `ai_source_not_image`). The same rights as uploading a ' +
        'version, then the AI checks (AI on, the plan, the budget — 402 / 403) and the shared AI change rate (429). ' +
        'A model that cannot edit pictures: 422 `ai_model_no_image_edit`, nothing charged. The cost is recorded in ' +
        'AI usage (source `image`); the item activity gets `file.version_added` with `ai: true` and the instruction. ' +
        '"Make current" on the version before undoes it.',
      middleware,
      request: {
        headers: accountHeader,
        params: idParam,
        ...jsonBody(
          z.object({
            instruction: z.string().trim().min(1).max(AI_EDIT_INSTRUCTION_MAX),
            version_id: z.string().min(1).max(40).optional(),
          }),
        ),
      },
      responses: {
        200: json(
          fileVersionSchema.extend({ from_version: z.number().int(), model: z.string(), cost_usd: z.number() }),
          'The new current version',
        ),
        ...errors(400, 401, 403, 404, 422, 423, 429),
      },
    }),
    async (c) => {
      const a = actorOf(c);
      const body = c.req.valid('json');
      const tool = aiTool('edit_file_image')!;
      const input = { file_id: c.req.valid('param').id, ...body };
      // The shared AI change rate (and support view / plan status / the `ai` feature), right before the spend.
      const guard = () => guardToolCall(deps, { surface: 'app', actor: a, tool, input });
      return c.json(
        await aiEditFile(deps, a, input.file_id, { instruction: body.instruction, versionId: body.version_id }, guard),
        200,
      );
    },
  );
  // "Download all": a browser download cannot send headers — the account may come as ?account_id=.
  const zipMiddleware = [requireAccount(deps, { query: true })];
  // `check=1`: the same checks, answered as JSON without the file — the app asks first, so a refusal is a message,
  // not an error page in place of a download.
  const zipQuery = z.object({ account_id: z.string().optional(), check: z.enum(['1']).optional() });
  const zipResponses = {
    200: {
      description: 'The ZIP, streamed (or, with `check=1`, how many files it would hold)',
      content: {
        'application/zip': { schema: z.string() },
        'application/json': { schema: z.object({ files: z.number().int(), skipped: z.number().int() }) },
      },
    },
    ...errors(401, 403, 404, 413, 423),
  };
  const zipResponse = (zip: FilesZip, check: boolean) => {
    if (check) {
      zip.stream.destroy();
      return Response.json({ files: zip.files, skipped: zip.skipped }) as never;
    }
    return new Response(Readable.toWeb(zip.stream) as ReadableStream, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': contentDisposition(zip.fileName),
        'cache-control': 'private, no-store',
        'x-files-skipped': String(zip.skipped),
      },
    }) as never;
  };
  r.openapi(
    createRoute({
      method: 'get',
      path: '/items/{id}/cells/{columnId}/files.zip',
      tags,
      summary: "Download all of a files cell's files as one ZIP",
      description:
        'Streamed. Each file is checked like `GET /files/{id}`; one the caller may not read is left out (the ZIP ' +
        'holds a note with how many, never their names; header `x-files-skipped`). The account setting ' +
        '`downloads` turns it off (403 `zip_disabled`) and limits it (413 `zip_too_many_files` / `zip_too_large`). ' +
        'The account may also come as `?account_id=`.',
      middleware: zipMiddleware,
      request: { params: cellParams, query: zipQuery },
      responses: zipResponses,
    }),
    async (c) => {
      const { id, columnId } = c.req.valid('param');
      return zipResponse(await cellFilesZip(deps, actorOf(c), id, columnId), c.req.valid('query').check === '1');
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/updates/{id}/files.zip',
      tags,
      summary: "Download all of an update's files as one ZIP",
      description: 'Like the files-cell ZIP: streamed, each file checked, the same `downloads` setting and limits.',
      middleware: zipMiddleware,
      request: { params: idParam, query: zipQuery },
      responses: zipResponses,
    }),
    async (c) =>
      zipResponse(await updateFilesZip(deps, actorOf(c), c.req.valid('param').id), c.req.valid('query').check === '1'),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/files/{id}',
      tags,
      summary: 'Discard an own upload that was never attached (it leaves storage at once)',
      description:
        'For the update composer: a file removed before posting. Only the uploader; 409 `file_in_use` once a ' +
        'cell or an update holds it (remove it from there instead).',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Discarded'), ...errors(400, 401, 403, 404, 409, 423) },
    }),
    async (c) => {
      await svc.discardUpload(deps, actorOf(c), c.req.valid('param').id);
      return c.json({ ok: true as const }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/cells/{columnId}/files',
      tags,
      summary: 'Attach uploaded files to a file cell',
      middleware,
      request: {
        headers: accountHeader,
        params: cellParams,
        ...jsonBody(z.object({ file_ids: z.array(z.string()).min(1).max(20) })),
      },
      responses: { 200: json(okSchema, 'Attached'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      await svc.attachToCell(deps, actorOf(c), p.id, p.columnId, c.req.valid('json').file_ids);
      return c.json({ ok: true as const }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/items/{id}/cells/{columnId}/files/{fileId}',
      tags,
      summary: 'Remove a file from a file cell (it goes to the trash with its versions)',
      middleware,
      request: {
        headers: accountHeader,
        params: cellParams.extend({ fileId: z.string().openapi({ param: { name: 'fileId', in: 'path' } }) }),
      },
      responses: { 200: json(okSchema, 'Removed'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      await svc.detachFromCell(deps, actorOf(c), p.id, p.columnId, p.fileId);
      return c.json({ ok: true as const }, 200);
    },
  );

  // --- links: web links in a files cell, beside its files and docs ----
  const linkParams = cellParams.extend({ linkId: z.string().openapi({ param: { name: 'linkId', in: 'path' } }) });
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/cells/{columnId}/links',
      tags,
      summary: 'Add a link to a files cell',
      description:
        'An http(s) address (`example.com` gains `https://`) and an optional name shown instead of it. At most ' +
        `${FILE_CELL_LINKS_MAX} links per cell; 400 \`invalid_link\` for anything else (e.g. \`javascript:\`). ` +
        'The cell value lists them under `links`.',
      middleware,
      request: { headers: accountHeader, params: cellParams, ...jsonBody(addCellLinkSchema) },
      responses: { 200: json(cellLinkSchema, 'The new link'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await addCellLink(deps.db, actorOf(c), p.id, p.columnId, c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/items/{id}/cells/{columnId}/links/{linkId}',
      tags,
      summary: "Change a files cell's link (its address and / or name)",
      middleware,
      request: { headers: accountHeader, params: linkParams, ...jsonBody(updateCellLinkSchema) },
      responses: { 200: json(cellLinkSchema, 'The link'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await updateCellLink(deps.db, actorOf(c), p.id, p.columnId, p.linkId, c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/items/{id}/cells/{columnId}/links/{linkId}',
      tags,
      summary: 'Remove a link from a files cell',
      description: 'Undoable from the activity log, like every cell change.',
      middleware,
      request: { headers: accountHeader, params: linkParams },
      responses: { 200: json(okSchema, 'Removed'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      await removeCellLink(deps.db, actorOf(c), p.id, p.columnId, p.linkId);
      return c.json({ ok: true as const }, 200);
    },
  );
  return r;
};
