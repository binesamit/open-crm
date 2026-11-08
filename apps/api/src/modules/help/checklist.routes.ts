// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  AppError,
  checklistDismissSchema,
  checklistMarkSchema,
  checklistSeenQuerySchema,
  checklistStateSchema,
  checklistStepSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { currentUser, requireAccount, requireSupportConsole, requireUser } from '../../middleware/auth';
import { errors, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  type ChecklistReader,
  checklistSeen,
  checklistSteps,
  dismissChecklist,
  markChecklist,
  myChecklist,
} from './checklist.service';
import { localeOf } from './help.reader';
import { loadHelpSettings } from './help.settings';

/**
 * "First steps": a person's self-ticking checklist inside an account (`/me/first-steps*`, the
 * person's session only), and the steps in force for the owner console's editor.
 */
export const checklistRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();
  const mw = [requireAccount(deps)];
  const tags = ['support'];
  const common = errors(400, 401, 403, 404, 422);
  const reader = (c: Context<AppEnv>): ChecklistReader => {
    if (c.get('token')) throw new AppError('forbidden', 'first_steps_session_only');
    const ctx = c.get('account');
    const user = currentUser(c);
    return {
      userId: user.id,
      accountId: ctx.accountId,
      role: ctx.role,
      locale: localeOf(user.locale),
      support: !!ctx.support,
    };
  };

  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/first-steps',
      tags,
      summary: 'My first steps here: each step, whether I did it, and its "show me" tour',
      middleware: mw,
      responses: { 200: json(checklistStateSchema, 'First steps'), ...common },
    }),
    async (c) => c.json(await myChecklist(deps, reader(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/me/first-steps/mark',
      tags,
      summary: 'Report a first step the activity log does not record (a board opened, a view switched)',
      middleware: mw,
      request: jsonBody(checklistMarkSchema),
      responses: { 200: json(okSchema, 'Saved'), ...common },
    }),
    async (c) => c.json(await markChecklist(deps, reader(c), c.req.valid('json').event), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/me/first-steps/dismiss',
      tags,
      summary: 'Close my first steps (or open them again), or fold them into their pill (or unfold them)',
      middleware: mw,
      request: jsonBody(checklistDismissSchema),
      responses: { 200: json(okSchema, 'Saved'), ...common },
    }),
    async (c) => c.json(await dismissChecklist(deps, reader(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/first-steps/seen',
      tags,
      summary: 'Did I do this since then (a tour step waiting for an action)',
      middleware: mw,
      request: { query: checklistSeenQuerySchema },
      responses: { 200: json(z.object({ seen: z.boolean() }), 'Seen'), ...common },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(await checklistSeen(deps, reader(c), q.event, new Date(q.since)), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/help/first-steps',
      tags: ['platform'],
      summary: 'The first steps in force (the built-in ones, in my language, until the owner saves a list)',
      middleware: [requireUser(), requireSupportConsole(deps)],
      responses: {
        200: json(z.object({ custom: z.boolean(), steps: z.array(checklistStepSchema) }), 'Steps'),
        ...errors(401, 404),
      },
    }),
    async (c) => {
      const s = (await loadHelpSettings(deps.db)).first_steps;
      return c.json({ custom: !!s.steps, steps: checklistSteps(s, localeOf(currentUser(c).locale)) }, 200);
    },
  );

  return r;
};
