// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  AppError,
  formSchema,
  publicFormSchema,
  publicSubmitResultSchema,
  publicSubmitSchema,
  publicUploadResultSchema,
  publicUploadSchema,
  updateFormSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody } from '../../lib/openapi';
import { ipBucket } from '../../lib/client-ip';
import { RateLimiter } from '../../lib/rate-limit';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './forms.service';
import { getPublicForm, presignFormUpload, submitForm, type Visitor } from './forms.public';

const tokenParam = z.object({ token: z.string().openapi({ param: { name: 'token', in: 'path' } }) });
const common = errors(400, 401, 403, 404, 409, 422);
const publicErrors = errors(400, 401, 404, 409, 413, 422, 429);

/** Anti-spam budgets of the public form endpoints (per form and client address, and per form overall). */
export const FORM_LIMITS = {
  submitPerIp: { limit: 10, windowMs: 10 * 60_000 },
  submitPerForm: { limit: 500, windowMs: 60 * 60_000 },
  uploadPerIp: { limit: 40, windowMs: 10 * 60_000 },
};

/**
 * Public forms (M11): the editor's endpoints on a form view (account-scoped) and the public page's endpoints
 * (`/public/forms/:token`, no account header — the token names the form; a members-only form uses the session).
 */
export const formRoutes = (deps: AppDeps) => {
  const scoped = [requireAccount(deps)];
  const visitor = (c: Context<AppEnv>): Visitor => ({
    user: c.get('user'),
    ip: c.get('clientIp'),
    userAgent: c.req.header('user-agent') ?? null,
  });
  // Fresh per app: the real client address (S-10) per form, plus a ceiling per form whatever the address.
  const submitPerIp = new RateLimiter(FORM_LIMITS.submitPerIp.limit, FORM_LIMITS.submitPerIp.windowMs);
  const submitPerForm = new RateLimiter(FORM_LIMITS.submitPerForm.limit, FORM_LIMITS.submitPerForm.windowMs);
  const uploadPerIp = new RateLimiter(FORM_LIMITS.uploadPerIp.limit, FORM_LIMITS.uploadPerIp.windowMs);
  const charge = (c: Context<AppEnv>, ...hits: [RateLimiter, string][]) => {
    for (const [limiter, key] of hits) {
      const waitMs = limiter.hit(key);
      if (waitMs > 0) {
        c.header('Retry-After', String(Math.ceil(waitMs / 1000)));
        throw new AppError('rate_limited', 'Too many requests', { retry_after_ms: waitMs });
      }
    }
  };

  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/views/{id}/form',
      tags: ['forms'],
      summary: 'The form of a form view (created with defaults on first open)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(formSchema, 'Form'), ...common },
    }),
    async (c) => c.json(await svc.getForm(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/views/{id}/form',
      tags: ['forms'],
      summary: 'Save the form: questions, texts, access, limits, embedding, Turnstile',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateFormSchema) },
      responses: { 200: json(formSchema, 'Form'), ...common },
    }),
    async (c) => c.json(await svc.updateForm(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/views/{id}/form/token',
      tags: ['forms'],
      summary: 'Replace the public link (the old one stops working)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(formSchema, 'Form'), ...common },
    }),
    async (c) => c.json(await svc.regenerateToken(deps, actorOf(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/forms/{token}',
      tags: ['forms'],
      summary: 'A public form as its page shows it (no account data beyond the configured questions)',
      security: [],
      request: { params: tokenParam },
      responses: { 200: json(publicFormSchema, 'Form'), ...publicErrors },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      return c.json(await getPublicForm(deps, c.req.valid('param').token, visitor(c)), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/forms/{token}/uploads',
      tags: ['forms'],
      summary: 'Start a file upload for a file question (presigned PUT; size and type limits checked)',
      security: [],
      request: { params: tokenParam, ...jsonBody(publicUploadSchema) },
      responses: { 200: json(publicUploadResultSchema, 'Upload'), ...publicErrors },
    }),
    async (c) => {
      const { token } = c.req.valid('param');
      charge(c, [uploadPerIp, `${token}|${ipBucket(c.get('clientIp'))}`]);
      return c.json(await presignFormUpload(deps, token, visitor(c), c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/forms/{token}/submit',
      tags: ['forms'],
      summary: 'Submit a public form: creates an item on the board ("via form")',
      security: [],
      request: { params: tokenParam, ...jsonBody(publicSubmitSchema) },
      responses: { 200: json(publicSubmitResultSchema, 'Submitted'), ...publicErrors },
    }),
    async (c) => {
      const { token } = c.req.valid('param');
      charge(c, [submitPerIp, `${token}|${ipBucket(c.get('clientIp'))}`], [submitPerForm, token]);
      return c.json(await submitForm(deps, token, visitor(c), c.req.valid('json')), 200);
    },
  );

  return r;
};
