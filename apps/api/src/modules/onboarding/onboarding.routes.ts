// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  onboardingAiReplySchema,
  onboardingAiTurnSchema,
  onboardingBuildSchema,
  onboardingBuiltSchema,
  onboardingKitInstallSchema,
  onboardingStateSchema,
} from '@bines/shared';
import { actorOf, currentUser, requestMeta, requireAccount } from '../../middleware/auth';
import { errors, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  buildOnboarding,
  installOnboardingKit,
  onboardingAiTurn,
  onboardingState,
  removeSampleData,
  skipOnboarding,
} from './onboarding.service';

const tags = ['onboarding'];

/** "How to start?" after a self sign-up: a gallery kit, or a blueprint from AI, built in one go. */
export const onboardingRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();
  const mw = [requireAccount(deps)];
  const common = errors(400, 401, 403, 404, 409, 422);

  r.openapi(
    createRoute({
      method: 'get',
      path: '/onboarding',
      tags,
      summary: 'What the start screen shows me: the gallery kits, "Build with AI", the boards my plan still allows',
      middleware: mw,
      responses: { 200: json(onboardingStateSchema, 'Start screen'), ...common },
    }),
    async (c) => c.json(await onboardingState(deps, actorOf(c), currentUser(c).locale ?? undefined), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/onboarding/kit',
      tags,
      summary: 'Build a gallery kit into the account (admins; within the plan’s boards)',
      middleware: mw,
      request: jsonBody(onboardingKitInstallSchema),
      responses: {
        201: json(z.object({ workspace_id: z.string().nullable() }), 'Built'),
        ...common,
      },
    }),
    async (c) => {
      const body = c.req.valid('json');
      return c.json(await installOnboardingKit(deps, actorOf(c), body.kit, requestMeta(c), body.sample_data), 201);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/onboarding/ai',
      tags,
      summary: 'One "Build with AI" turn: a question back, or a proposed structure (nothing is built)',
      description:
        'Runs on the platform’s AI connection, within what the platform pays per account (owner console). The client keeps the conversation and sends it each turn.',
      middleware: mw,
      request: jsonBody(onboardingAiTurnSchema),
      responses: { 200: json(onboardingAiReplySchema, 'Reply'), ...common },
    }),
    async (c) => c.json(await onboardingAiTurn(deps, actorOf(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/onboarding/build',
      tags,
      summary: 'Build a proposed structure in one go: its boards (with sample rows) and dashboard',
      middleware: mw,
      request: jsonBody(onboardingBuildSchema),
      responses: { 201: json(onboardingBuiltSchema, 'Built'), ...common },
    }),
    async (c) => c.json(await buildOnboarding(deps, actorOf(c), c.req.valid('json')), 201),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/onboarding/sample',
      tags,
      summary: 'Delete the sample data: every sample row a kit / a built structure brought goes to the trash',
      description: 'One batch: undoing it (`POST /activity/batches/{id}/undo`) brings every row back.',
      middleware: mw,
      responses: {
        200: json(z.object({ removed: z.number().int(), batch_id: z.string().nullable() }), 'Removed'),
        ...common,
      },
    }),
    async (c) => c.json(await removeSampleData(deps, actorOf(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/onboarding/skip',
      tags,
      summary: 'Close the start screen for good',
      middleware: mw,
      responses: { 200: json(okSchema, 'Closed'), ...common },
    }),
    async (c) => c.json(await skipOnboarding(deps, actorOf(c), requestMeta(c)), 200),
  );

  return r;
};
