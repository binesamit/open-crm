// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import {
  accountCaptchaSchema,
  platformCaptchaSchema,
  updateAccountCaptchaSchema,
  updatePlatformCaptchaSchema,
} from '@bines/shared';
import {
  currentUser,
  requestMeta,
  requireAccount,
  requirePlatformOwner,
  requireUser,
  actorOf,
} from '../../middleware/auth';
import { accountHeader, errors, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { getAccountCaptcha, getPlatformCaptcha, updateAccountCaptcha, updatePlatformCaptcha } from './captcha.service';

/**
 * Cloudflare Turnstile settings: the account's (Administration → Security, admins) and the
 * platform's (owner console, the platform owner — 404 to everyone else). The secret is write-only.
 */
export const captchaRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();
  const middleware = [requireAccount(deps)];
  const common = errors(400, 401, 403, 404, 422);
  r.openapi(
    createRoute({
      method: 'get',
      path: '/security/captcha',
      tags: ['security'],
      summary: "The account's Turnstile: keys (the secret only as set / not set), master switch, public places",
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(accountCaptchaSchema, 'Turnstile'), ...common },
    }),
    async (c) => c.json(await getAccountCaptcha(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/security/captcha',
      tags: ['security'],
      summary: "Change the account's Turnstile (admin) — audited as security.captcha_changed; on needs both keys",
      middleware,
      request: { headers: accountHeader, ...jsonBody(updateAccountCaptchaSchema) },
      responses: { 200: json(accountCaptchaSchema, 'Turnstile'), ...common },
    }),
    async (c) => c.json(await updateAccountCaptcha(deps, actorOf(c), c.req.valid('json'), requestMeta(c)), 200),
  );

  const owner = [requireUser(), requirePlatformOwner()];
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/captcha',
      tags: ['platform'],
      summary: "The platform's Turnstile (sign-in, sign-up, forgot password)",
      middleware: owner,
      responses: { 200: json(platformCaptchaSchema, 'Turnstile'), ...errors(401, 404) },
    }),
    async (c) => c.json(await getPlatformCaptcha(deps), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/captcha',
      tags: ['platform'],
      summary: "Change the platform's Turnstile (only what is sent); on needs both keys",
      middleware: owner,
      request: jsonBody(updatePlatformCaptchaSchema),
      responses: { 200: json(platformCaptchaSchema, 'Turnstile'), ...errors(400, 401, 404, 422) },
    }),
    async (c) => c.json(await updatePlatformCaptcha(deps, currentUser(c), c.req.valid('json')), 200),
  );
  return r;
};
