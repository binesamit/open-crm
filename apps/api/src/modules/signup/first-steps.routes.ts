// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { firstStepsSchema } from '@bines/shared';
import { currentUser, requirePlatformOwner, requireUser } from '../../middleware/auth';
import { errors, json } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { dismissFirstSteps, getFirstSteps } from './first-steps';

const tags = ['platform'];
const ownerGuard = [requireUser(), requirePlatformOwner()];

/** The owner console's "first steps" card (SIGNUP plan, decision 12): platform owner only (404 to anyone else). */
export const firstStepsRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/first-steps',
      tags,
      summary: "The owner console's first steps: what is done, and whether the card was closed",
      description:
        'Steps in order: `registration`, `email`, `legal`, `plan`, `signup` — each read from the real settings, so it is done as soon as the setting is in place.',
      middleware: ownerGuard,
      responses: { 200: json(firstStepsSchema, 'First steps'), ...errors(401, 404) },
    }),
    async (c) => c.json(await getFirstSteps(deps), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/first-steps/dismiss',
      tags,
      summary: 'Close the first steps card for good',
      middleware: ownerGuard,
      responses: { 200: json(firstStepsSchema, 'First steps'), ...errors(401, 404) },
    }),
    async (c) => c.json(await dismissFirstSteps(deps, currentUser(c)), 200),
  );

  return r;
};
