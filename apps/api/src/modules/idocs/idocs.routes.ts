// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  AppError,
  createIdocDocSchema,
  createIdocTemplateSchema,
  idocCertificateSchema,
  idocDocSchema,
  idocEventSchema,
  idocSectionsSchema,
  idocSettingsSchema,
  idocTemplateSchema,
  publicIdocAskSchema,
  publicIdocInputsSchema,
  publicIdocSchema,
  publicIdocSelectResultSchema,
  publicIdocSelectSchema,
  publicIdocSignResultSchema,
  publicIdocSignSchema,
  publicIdocVerifyCheckSchema,
  publicIdocVerifyResultSchema,
  sendIdocDocSchema,
  updateIdocDocSchema,
  updateIdocTemplateSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { actorOf, requireAccount } from '../../middleware/auth';
import { ipBucket } from '../../lib/client-ip';
import { accountHeader, errors, idParam, json, jsonBody } from '../../lib/openapi';
import { RateLimiter } from '../../lib/rate-limit';
import type { AppDeps, AppEnv } from '../../types';
import { contentDisposition } from '../export/export.service';
import { memberDocPdf } from './idocs.export';
import * as pub from './idocs.public';
import * as svc from './idocs.service';

const common = errors(400, 401, 403, 404, 409, 422);
const publicErrors = errors(400, 401, 403, 404, 409, 422, 429);
const ok = z.object({ ok: z.literal(true) });
const pdfErrors = errors(400, 401, 403, 404, 413, 422, 429);
const pdfResponse = (file: { bytes: Uint8Array; fileName: string }) =>
  new Response(file.bytes, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': contentDisposition(file.fileName),
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  }) as never;
const pdfContent = {
  200: {
    description: 'The document as PDF (A4): sections, choices and totals; signed: the signature and its certificate',
    content: { 'application/pdf': { schema: z.string().openapi({ format: 'binary' }) } },
  },
};
const tokenParam = z.object({ token: z.string().openapi({ param: { name: 'token', in: 'path' } }) });
const fileParam = tokenParam.extend({
  ref: z
    .string()
    .max(40)
    .openapi({ param: { name: 'ref', in: 'path' } }),
});

/** Budgets of the public page, per document and client address (and per document for the code emails). */
export const IDOC_LIMITS_PUBLIC = {
  read: { limit: 240, windowMs: 10 * 60_000 },
  write: { limit: 300, windowMs: 10 * 60_000 },
  ask: { limit: 20, windowMs: 10 * 60_000 },
  codeSend: { limit: 5, windowMs: 10 * 60_000 },
  codeCheck: { limit: 12, windowMs: 10 * 60_000 },
  sign: { limit: 10, windowMs: 10 * 60_000 },
  /** PDF downloads: drawn on the server, so a tighter budget than reads. */
  pdf: { limit: 20, windowMs: 10 * 60_000 },
};

/**
 * Interactive documents: templates and an item's documents (account-scoped), and the public page's
 * endpoints (`/public/idocs/{token}`, no account header; the visitor's one-time-code key in `X-Idoc-Key`).
 */
export const idocRoutes = (deps: AppDeps) => {
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();
  const limiters = Object.fromEntries(
    Object.entries(IDOC_LIMITS_PUBLIC).map(([k, v]) => [k, new RateLimiter(v.limit, v.windowMs)]),
  ) as Record<keyof typeof IDOC_LIMITS_PUBLIC, RateLimiter>;
  const charge = (c: Context<AppEnv>, kind: keyof typeof IDOC_LIMITS_PUBLIC, key: string) => {
    const waitMs = limiters[kind].hit(key);
    if (waitMs > 0) {
      c.header('Retry-After', String(Math.ceil(waitMs / 1000)));
      throw new AppError('rate_limited', 'Too many requests', { retry_after_ms: waitMs });
    }
  };
  const visitor = (c: Context<AppEnv>): pub.Visitor => ({
    ip: c.get('clientIp'),
    userAgent: c.req.header('user-agent') ?? null,
    // The page's calls send the key as a header; its <img> / file links (which cannot) as `?k=`.
    key: (c.req.header('x-idoc-key') ?? c.req.query('k'))?.slice(0, 80) ?? null,
    requestId: c.get('requestId'),
    userId: c.get('user')?.id ?? null,
  });
  const per = (c: Context<AppEnv>, token: string) => `${token}|${ipBucket(c.get('clientIp'))}`;

  // ——— templates ———
  r.openapi(
    createRoute({
      method: 'get',
      path: '/idoc-templates',
      tags: ['idocs'],
      summary: 'Interactive document templates (account-wide, plus the board’s own when board_id is given)',
      middleware: scoped,
      request: { headers: accountHeader, query: z.object({ board_id: z.string().max(26).optional() }) },
      responses: { 200: json(z.object({ data: z.array(idocTemplateSchema) }), 'Templates'), ...common },
    }),
    async (c) => c.json({ data: await svc.listTemplates(deps, actorOf(c), c.req.valid('query').board_id) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/idoc-templates',
      tags: ['idocs'],
      summary: 'Create a template (blank, from a starter, a copy of a template or of a document)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(createIdocTemplateSchema) },
      responses: { 200: json(idocTemplateSchema, 'Template'), ...common },
    }),
    async (c) => c.json(await svc.createTemplate(deps, actorOf(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/idoc-templates/{id}',
      tags: ['idocs'],
      summary: 'A template',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(idocTemplateSchema, 'Template'), ...common },
    }),
    async (c) => c.json(await svc.getTemplate(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/idoc-templates/{id}',
      tags: ['idocs'],
      summary: 'Change a template: name, board, sections, settings (its creator or an admin)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateIdocTemplateSchema) },
      responses: { 200: json(idocTemplateSchema, 'Template'), ...common },
    }),
    async (c) => c.json(await svc.updateTemplate(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/idoc-templates/{id}',
      tags: ['idocs'],
      summary: 'Delete a template (documents made from it keep their copy)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(ok, 'Deleted'), ...common },
    }),
    async (c) => {
      await svc.deleteTemplate(deps, actorOf(c), c.req.valid('param').id);
      return c.json({ ok: true as const }, 200);
    },
  );

  // ——— an item's documents ———
  r.openapi(
    createRoute({
      method: 'get',
      path: '/items/{id}/idocs',
      tags: ['idocs'],
      summary: 'The interactive documents of an item',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(z.object({ data: z.array(idocDocSchema) }), 'Documents'), ...common },
    }),
    async (c) => c.json({ data: await svc.listItemDocs(deps, actorOf(c), c.req.valid('param').id) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/idocs',
      tags: ['idocs'],
      summary: 'Make a document for an item from a template or a starter (a draft with its own public link)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(createIdocDocSchema) },
      responses: { 200: json(idocDocSchema, 'Document'), ...common },
    }),
    async (c) => c.json(await svc.createDoc(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/idocs/{id}',
      tags: ['idocs'],
      summary: 'A document',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(idocDocSchema, 'Document'), ...common },
    }),
    async (c) => c.json(await svc.getDoc(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/idocs/{id}',
      tags: ['idocs'],
      summary: 'Change a document: name, sections, settings (not after signing while it locks)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateIdocDocSchema) },
      responses: { 200: json(idocDocSchema, 'Document'), ...common },
    }),
    async (c) => c.json(await svc.updateDoc(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/idocs/{id}',
      tags: ['idocs'],
      summary: 'Delete a document (a signed one: admins only)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(ok, 'Deleted'), ...common },
    }),
    async (c) => {
      await svc.deleteDoc(deps, actorOf(c), c.req.valid('param').id);
      return c.json({ ok: true as const }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/idocs/{id}/send',
      tags: ['idocs'],
      summary: 'Send the link to the contact by email (or mark as sent); opens the link for the set days',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(sendIdocDocSchema) },
      responses: { 200: json(idocDocSchema, 'Document'), ...common },
    }),
    async (c) => c.json(await svc.sendDoc(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  const action = (
    path: string,
    summary: string,
    fn: (id: string, c: Context<AppEnv>) => Promise<z.infer<typeof idocDocSchema>>,
  ) =>
    r.openapi(
      createRoute({
        method: 'post',
        path: `/idocs/{id}/${path}`,
        tags: ['idocs'],
        summary,
        middleware: scoped,
        request: { headers: accountHeader, params: idParam },
        responses: { 200: json(idocDocSchema, 'Document'), ...common },
      }),
      async (c) => c.json(await fn(c.req.valid('param').id, c), 200),
    );
  action('token', 'Replace the public link (the old one stops working)', (id, c) =>
    svc.replaceToken(deps, actorOf(c), id),
  );
  action('revoke', 'Close the public link', (id, c) => svc.revokeDoc(deps, actorOf(c), id));
  action('reopen', 'Reopen a signed, closed or expired document (a signed one gets a new version)', (id, c) =>
    svc.reopenDoc(deps, actorOf(c), id),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/idocs/{id}/pdf',
      tags: ['idocs'],
      summary: 'The document as PDF — what the client sees now, or (signed) what was signed with its certificate',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { ...pdfContent, ...pdfErrors },
    }),
    async (c) => pdfResponse(await memberDocPdf(deps, actorOf(c), c.req.valid('param').id)),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/idocs/{id}/events',
      tags: ['idocs'],
      summary: 'The document’s log: sent, opened, choices, questions, signing',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(z.object({ data: z.array(idocEventSchema) }), 'Events'), ...common },
    }),
    async (c) => c.json({ data: await svc.listDocEvents(deps, actorOf(c), c.req.valid('param').id) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/idocs/{id}/preview',
      tags: ['idocs'],
      summary: 'The page as the client sees it, with unsaved sections / settings (the builder’s preview)',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: idParam,
        ...jsonBody(
          z.object({
            sections: idocSectionsSchema.optional(),
            settings: idocSettingsSchema.optional(),
            /** Whose default look to show: a guest's (the client) or a member's. */
            audience: z.enum(['guests', 'members']).optional(),
          }),
        ),
      },
      responses: { 200: json(publicIdocSchema, 'Page'), ...common },
    }),
    async (c) => c.json(await svc.previewDoc(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/signatures/{id}',
      tags: ['idocs'],
      summary: 'A signature’s certificate: signer, identity check, time, source, consents, content hash, log',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(idocCertificateSchema, 'Certificate'), ...common },
    }),
    async (c) => c.json(await svc.certificate(deps, actorOf(c), c.req.valid('param').id), 200),
  );

  // ——— the public page ———
  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/idocs/{token}',
      tags: ['idocs'],
      summary: 'Public: a document as its page shows it',
      security: [],
      request: { params: tokenParam },
      responses: { 200: json(publicIdocSchema, 'Page'), ...publicErrors },
    }),
    async (c) => {
      const { token } = c.req.valid('param');
      charge(c, 'read', per(c, token));
      c.header('Cache-Control', 'no-store');
      c.header('Referrer-Policy', 'no-referrer');
      return c.json(await pub.getPublicDoc(deps, token, visitor(c)), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/idocs/{token}/verify',
      tags: ['idocs'],
      summary: 'Public: email a one-time code to the document’s contact',
      security: [],
      request: { params: tokenParam },
      responses: { 200: json(z.object({ email_hint: z.string() }), 'Sent'), ...publicErrors },
    }),
    async (c) => {
      const { token } = c.req.valid('param');
      charge(c, 'codeSend', token);
      return c.json(await pub.startVerify(deps, token, visitor(c)), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/idocs/{token}/verify/check',
      tags: ['idocs'],
      summary: 'Public: check the code; answers the visitor key for X-Idoc-Key',
      security: [],
      request: { params: tokenParam, ...jsonBody(publicIdocVerifyCheckSchema) },
      responses: { 200: json(publicIdocVerifyResultSchema, 'Verified'), ...publicErrors },
    }),
    async (c) => {
      const { token } = c.req.valid('param');
      charge(c, 'codeCheck', per(c, token));
      return c.json(await pub.checkVerify(deps, token, visitor(c), c.req.valid('json').code), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/idocs/{token}/select',
      tags: ['idocs'],
      summary: 'Public: tick / untick a row or change its quantity (the section’s rules apply)',
      security: [],
      request: { params: tokenParam, ...jsonBody(publicIdocSelectSchema) },
      responses: { 200: json(publicIdocSelectResultSchema, 'Rows'), ...publicErrors },
    }),
    async (c) => {
      const { token } = c.req.valid('param');
      charge(c, 'write', per(c, token));
      return c.json(await pub.selectRow(deps, token, visitor(c), c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/idocs/{token}/inputs',
      tags: ['idocs'],
      summary: 'Public: save the client’s details of an inputs section (into the item’s columns)',
      security: [],
      request: { params: tokenParam, ...jsonBody(publicIdocInputsSchema) },
      responses: { 200: json(ok, 'Saved'), ...publicErrors },
    }),
    async (c) => {
      const { token } = c.req.valid('param');
      charge(c, 'write', per(c, token));
      return c.json((await pub.saveInputs(deps, token, visitor(c), c.req.valid('json'))) as { ok: true }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/idocs/{token}/questions',
      tags: ['idocs'],
      summary: 'Public: ask a question (an update on the item) or reply in one of the document’s threads',
      security: [],
      request: { params: tokenParam, ...jsonBody(publicIdocAskSchema) },
      responses: { 200: json(publicIdocSchema, 'Page'), ...publicErrors },
    }),
    async (c) => {
      const { token } = c.req.valid('param');
      charge(c, 'ask', per(c, token));
      return c.json(await pub.ask(deps, token, visitor(c), c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/idocs/{token}/sign',
      tags: ['idocs'],
      summary: 'Public: approve / sign — stores the evidence and the content hash, locks the document',
      security: [],
      request: { params: tokenParam, ...jsonBody(publicIdocSignSchema) },
      responses: { 200: json(publicIdocSignResultSchema, 'Signed'), ...publicErrors },
    }),
    async (c) => {
      const { token } = c.req.valid('param');
      charge(c, 'sign', per(c, token));
      return c.json(await pub.sign(deps, token, visitor(c), c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/idocs/{token}/files/{ref}',
      tags: ['idocs'],
      summary: 'Public: a file the page shows → redirect to a short-lived link',
      security: [],
      request: { params: fileParam },
      responses: { 302: { description: 'Redirect to a short-lived signed URL' }, ...publicErrors },
    }),
    async (c) => {
      const { token, ref } = c.req.valid('param');
      charge(c, 'read', per(c, token));
      c.header('Cache-Control', 'private, max-age=60');
      c.header('Referrer-Policy', 'no-referrer');
      return c.redirect(await pub.fileLink(deps, token, ref, visitor(c)), 302);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/idocs/{token}/pdf',
      tags: ['idocs'],
      summary: 'Public: the document as PDF (the one-time-code key in X-Idoc-Key or ?k=)',
      security: [],
      request: { params: tokenParam },
      responses: { ...pdfContent, ...pdfErrors },
    }),
    async (c) => {
      const { token } = c.req.valid('param');
      charge(c, 'pdf', per(c, token));
      return pdfResponse(await pub.publicPdf(deps, token, visitor(c)));
    },
  );

  return r;
};
