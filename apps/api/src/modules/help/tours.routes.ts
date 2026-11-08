// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  AppError,
  createTourSchema,
  HELP_LOCALES,
  myToursSchema,
  setTourAnchorSchema,
  setTourPrefsSchema,
  setTourProgressSchema,
  tourSchema,
  updateTourSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { currentUser, requireAccount, requireSupportConsole, requireUser } from '../../middleware/auth';
import { errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { localeOf } from './help.reader';
import {
  createTour,
  deleteTour,
  getTour,
  listTours,
  myTours,
  resetMyTours,
  setMyTourPrefs,
  setMyTourProgress,
  setTourAnchor,
  type TourReader,
  updateTour,
} from './tours.service';

/**
 * Guided tours: the owner console's Support → Knowledge → Tours (`/platform/support/help/tours*`, the
 * owner and support staff — 404 to everyone else) and a member's tours inside an account (`/support/tours*`).
 */
export const tourRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();

  // ---------------------------------------------------------------- console
  const consoleMw = [requireUser(), requireSupportConsole(deps)];
  const common = errors(400, 401, 403, 404, 409, 422);
  const ptags = ['platform'];
  const staff = (c: Context<AppEnv>) => ({ user: currentUser(c), role: c.get('supportRole') ?? 'agent' });
  const one = json(tourSchema, 'Tour');

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/help/tours',
      tags: ptags,
      summary: 'Guided tours (drafts and published), in their order',
      middleware: consoleMw,
      request: { query: z.object({ locale: z.enum(HELP_LOCALES).optional() }) },
      responses: { 200: json(z.object({ data: z.array(tourSchema) }).openapi('TourList'), 'Tours'), ...common },
    }),
    async (c) => c.json(await listTours(deps, staff(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support/help/tours',
      tags: ptags,
      summary: 'Create a guided tour (a draft)',
      middleware: consoleMw,
      request: jsonBody(createTourSchema),
      responses: { 201: one, ...common },
    }),
    async (c) => c.json(await createTour(deps, staff(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/help/tours/{id}',
      tags: ptags,
      summary: 'One guided tour (a draft too — the preview runs it)',
      middleware: consoleMw,
      request: { params: idParam },
      responses: { 200: one, ...common },
    }),
    async (c) => c.json(await getTour(deps, staff(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/support/help/tours/{id}',
      tags: ptags,
      summary: 'Change a guided tour (publishing it is for the publishing roles)',
      middleware: consoleMw,
      request: { params: idParam, ...jsonBody(updateTourSchema) },
      responses: { 200: one, ...common },
    }),
    async (c) => c.json(await updateTour(deps, staff(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/support/help/tours/{id}',
      tags: ptags,
      summary: 'Delete a guided tour',
      middleware: consoleMw,
      request: { params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...common },
    }),
    async (c) => c.json(await deleteTour(deps, staff(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support/help/tours/{id}/anchor',
      tags: ptags,
      summary: "Point a step at the element picked on the app's screen (its data-tour mark)",
      middleware: consoleMw,
      request: { params: idParam, ...jsonBody(setTourAnchorSchema) },
      responses: { 200: one, ...common },
    }),
    async (c) => c.json(await setTourAnchor(deps, staff(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  // ---------------------------------------------------------------- inside an account
  const accountMw = [requireAccount(deps)];
  const atags = ['support'];
  const acommon = errors(400, 401, 403, 404, 422);
  const reader = (c: Context<AppEnv>): TourReader => {
    const ctx = c.get('account');
    if (ctx.support) throw new AppError('forbidden', 'support_not_allowed');
    if (ctx.role === 'guest') throw new AppError('forbidden', 'help_not_for_guests');
    if (c.get('token')) throw new AppError('forbidden', 'tours_session_only');
    const user = currentUser(c);
    return { userId: user.id, accountId: ctx.accountId, role: ctx.role, locale: localeOf(user.locale) };
  };

  r.openapi(
    createRoute({
      method: 'get',
      path: '/support/tours',
      tags: atags,
      summary: 'The guided tours I may take here, with what I did with each',
      middleware: accountMw,
      responses: { 200: json(myToursSchema, 'Tours'), ...acommon },
    }),
    async (c) => c.json(await myTours(deps, reader(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/support/tours/{id}/progress',
      tags: atags,
      summary: 'Mark a tour finished or closed (null: offer it again)',
      middleware: accountMw,
      request: { params: idParam, ...jsonBody(setTourProgressSchema) },
      responses: { 200: json(okSchema, 'Saved'), ...acommon },
    }),
    async (c) =>
      c.json(await setMyTourProgress(deps, reader(c), c.req.valid('param').id, c.req.valid('json').state), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/support/tours/progress',
      tags: atags,
      summary: 'Reset every tour (each is offered again)',
      middleware: accountMw,
      responses: { 200: json(okSchema, 'Reset'), ...acommon },
    }),
    async (c) => c.json(await resetMyTours(deps, reader(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/support/tours/prefs',
      tags: atags,
      summary: 'My own switch: offer me tours on a first visit to a screen',
      middleware: accountMw,
      request: jsonBody(setTourPrefsSchema),
      responses: { 200: json(setTourPrefsSchema, 'Saved'), ...acommon },
    }),
    async (c) => c.json(await setMyTourPrefs(deps, reader(c).userId, c.req.valid('json')), 200),
  );

  return r;
};
