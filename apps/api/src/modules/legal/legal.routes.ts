// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  acceptLegalSchema,
  AppError,
  createLegalDocSchema,
  isLocale,
  legalDocAdminSchema,
  legalListSchema,
  subProcessorsListSchema,
  legalDocViewQuerySchema,
  legalDocViewSchema,
  legalConsentsExportQuerySchema,
  legalVersionSchema,
  publishLegalDocSchema,
  myLegalSchema,
  updateLegalDocSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { RateLimiter } from '../../lib/rate-limit';
import { errors, json, jsonBody, okSchema } from '../../lib/openapi';
import { currentUser, requestMeta, requirePlatformOwner, requireUser } from '../../middleware/auth';
import type { AppDeps, AppEnv } from '../../types';
import {
  acceptLegal,
  adminListLegalDocs,
  createLegalDoc,
  deleteLegalDoc,
  exportLegalConsents,
  exportMarketingOptIns,
  listLegalDocs,
  listSubProcessors,
  listLegalVersions,
  myPendingLegal,
  publishLegalDoc,
  restoreLegalVersion,
  updateLegalDoc,
  viewLegalDoc,
} from './legal.service';

/** Public legal-page reads per address per minute. */
const PUBLIC_PER_MIN = 120;

const slugParam = z.object({
  slug: z
    .string()
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .openapi({ param: { name: 'slug', in: 'path' } }),
});
const versionParam = slugParam.extend({
  version: z.coerce
    .number()
    .int()
    .min(1)
    .openapi({ param: { name: 'version', in: 'path' } }),
});

/** Legal documents: public pages, the owner console's editor, and each person's consent. */
export const legalRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();
  const limiter = new RateLimiter(PUBLIC_PER_MIN, 60_000);
  const charge = (c: Context<AppEnv>) => {
    const waitMs = limiter.hit(c.get('user')?.id ?? `ip:${c.get('clientIp') ?? 'unknown'}`);
    if (waitMs > 0) {
      c.header('Retry-After', String(Math.ceil(waitMs / 1000)));
      throw new AppError('rate_limited', 'Too many requests', { retry_after_ms: waitMs });
    }
  };
  const tags = ['legal'];

  // ------------------------------------------------------------------------------------------ public
  r.openapi(
    createRoute({
      method: 'get',
      path: '/legal',
      tags,
      summary: 'The published legal documents (terms, privacy …)',
      security: [],
      responses: { 200: json(legalListSchema, 'Documents'), ...errors(429) },
    }),
    async (c) => {
      charge(c);
      c.header('Cache-Control', 'no-store');
      return c.json(await listLegalDocs(deps), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/legal/sub-processors',
      tags,
      summary: 'The sub-processors list (who processes personal data for the operator), as the owner published it',
      security: [],
      responses: { 200: json(subProcessorsListSchema, 'Sub-processors'), ...errors(429) },
    }),
    async (c) => {
      charge(c);
      c.header('Cache-Control', 'no-store');
      return c.json(await listSubProcessors(deps), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/legal/{slug}',
      tags,
      summary: 'A published legal document, rendered',
      security: [],
      request: { params: slugParam, query: legalDocViewQuerySchema },
      responses: { 200: json(legalDocViewSchema, 'Document'), ...errors(404, 429) },
    }),
    async (c) => {
      charge(c);
      const q = c.req.valid('query');
      const user = c.get('user');
      const locale = q.locale ?? (user?.locale && isLocale(user.locale) ? user.locale : 'he');
      c.header('Cache-Control', 'no-store');
      return c.json(
        await viewLegalDoc(deps, c.req.valid('param').slug, {
          locale,
          version: q.version,
          owner: !!user?.isPlatformOwner,
        }),
        200,
      );
    },
  );

  // ------------------------------------------------------------------------------------------ me
  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/legal',
      tags,
      summary: 'Legal documents I still need to accept (their current version)',
      middleware: [requireUser()],
      responses: { 200: json(myLegalSchema, 'Pending'), ...errors(401) },
    }),
    async (c) => c.json({ pending: await myPendingLegal(deps, currentUser(c)) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/me/legal/accept',
      tags,
      summary: 'Accept the current version of legal documents',
      middleware: [requireUser()],
      request: jsonBody(acceptLegalSchema),
      responses: { 200: json(myLegalSchema, 'Still pending'), ...errors(400, 401) },
    }),
    async (c) => {
      if (c.get('token')) throw new AppError('forbidden', 'A person accepts legal documents, not a token');
      const pending = await acceptLegal(deps, currentUser(c), c.req.valid('json').accepted, 'prompt', requestMeta(c));
      return c.json({ pending }, 200);
    },
  );

  // ------------------------------------------------------------------------------------------ owner console
  const guard = [requireUser(), requirePlatformOwner()];
  const otags = ['platform'];
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/legal',
      tags: otags,
      summary: 'Legal documents with their drafts (owner console)',
      middleware: guard,
      responses: { 200: json(z.object({ data: z.array(legalDocAdminSchema) }), 'Documents'), ...errors(401, 404) },
    }),
    async (c) => c.json({ data: await adminListLegalDocs(deps) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/legal',
      tags: otags,
      summary: 'Add a legal document',
      middleware: guard,
      request: jsonBody(createLegalDocSchema),
      responses: { 200: json(legalDocAdminSchema, 'Document'), ...errors(400, 401, 404, 409) },
    }),
    async (c) => c.json(await createLegalDoc(deps, currentUser(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/legal/{slug}',
      tags: otags,
      summary: "Edit a legal document's draft and settings",
      middleware: guard,
      request: { params: slugParam, ...jsonBody(updateLegalDocSchema) },
      responses: { 200: json(legalDocAdminSchema, 'Document'), ...errors(400, 401, 404) },
    }),
    async (c) =>
      c.json(await updateLegalDoc(deps, currentUser(c), c.req.valid('param').slug, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/legal/{slug}',
      tags: otags,
      summary: 'Delete a legal document the owner added (built-in ones cannot be deleted)',
      middleware: guard,
      request: { params: slugParam },
      responses: { 200: json(okSchema, 'Deleted'), ...errors(401, 404, 409) },
    }),
    async (c) => {
      await deleteLegalDoc(deps, c.req.valid('param').slug);
      return c.json({ ok: true as const }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/legal/{slug}/publish',
      tags: otags,
      summary: 'Publish the draft as a new version (material: false = a minor change nobody accepts again)',
      middleware: guard,
      request: {
        params: slugParam,
        body: { required: false, content: { 'application/json': { schema: publishLegalDocSchema } } },
      },
      responses: { 200: json(legalDocAdminSchema, 'Document'), ...errors(400, 401, 404) },
    }),
    async (c) => {
      // The body is optional (older clients send none): no body = a material change.
      const raw = (await c.req.json().catch(() => ({}))) as unknown;
      const body = publishLegalDocSchema.safeParse(raw ?? {});
      if (!body.success) throw new AppError('validation_failed', 'Invalid body');
      return c.json(await publishLegalDoc(deps, currentUser(c), c.req.valid('param').slug, body.data), 200);
    },
  );
  const csvResponse = (body: string, name: string) =>
    new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
      },
    }) as never;
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/legal/consents.csv',
      tags: otags,
      summary: 'Who accepted which version of the legal documents, when and from where (CSV; one document or all)',
      middleware: guard,
      request: { query: legalConsentsExportQuerySchema },
      responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: z.string() } } }, ...errors(401, 404) },
    }),
    async (c) => {
      const { slug } = c.req.valid('query');
      return csvResponse(await exportLegalConsents(deps, slug), `consents${slug ? `-${slug}` : ''}.csv`);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/legal/marketing.csv',
      tags: otags,
      summary: 'The people who agreed to marketing email at sign-up or in their profile, and when (CSV)',
      middleware: guard,
      responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: z.string() } } }, ...errors(401, 404) },
    }),
    async () => csvResponse(await exportMarketingOptIns(deps), 'marketing-opt-ins.csv'),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/legal/{slug}/versions',
      tags: otags,
      summary: 'The published versions of a legal document',
      middleware: guard,
      request: { params: slugParam },
      responses: { 200: json(z.object({ data: z.array(legalVersionSchema) }), 'Versions'), ...errors(401, 404) },
    }),
    async (c) => c.json({ data: await listLegalVersions(deps, c.req.valid('param').slug) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/legal/{slug}/versions/{version}/restore',
      tags: otags,
      summary: 'Copy an older version into the draft',
      middleware: guard,
      request: { params: versionParam },
      responses: { 200: json(legalDocAdminSchema, 'Document'), ...errors(401, 404) },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await restoreLegalVersion(deps, currentUser(c), p.slug, p.version), 200);
    },
  );

  return r;
};
