// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  LOGIN_PROVIDERS,
  loginProvidersResponseSchema,
  loginProviderTestSchema,
  updateLoginProviderSchema,
} from '@bines/shared';
import { currentUser, requirePlatformOwner, requireUser } from '../../middleware/auth';
import { errors, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { listLoginProviders, testLoginProvider, updateLoginProvider } from './login-providers';

const guard = [requireUser(), requirePlatformOwner()];
const tags = ['platform'];
const providerParam = z.object({
  provider: z.enum(LOGIN_PROVIDERS).openapi({ param: { name: 'provider', in: 'path' } }),
});

/** Owner console → "ספקי התחברות": Google / Microsoft sign-in credentials. 404 to everyone else. */
export const loginProviderRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/login-providers',
      tags,
      summary: 'Sign-in providers (Google, Microsoft): what is saved, what is in effect, the return address',
      middleware: guard,
      responses: { 200: json(loginProvidersResponseSchema, 'Providers'), ...errors(401, 404) },
    }),
    async (c) => c.json(await listLoginProviders(deps), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/login-providers/{provider}',
      tags,
      summary:
        'Update a sign-in provider (only what is sent; the secret is write-only; null = back to the environment)',
      middleware: guard,
      request: { params: providerParam, ...jsonBody(updateLoginProviderSchema) },
      responses: { 200: json(loginProvidersResponseSchema, 'Providers'), ...errors(400, 401, 404, 422) },
    }),
    async (c) =>
      c.json(await updateLoginProvider(deps, currentUser(c), c.req.valid('param').provider, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/login-providers/{provider}/test',
      tags,
      summary: "Test a sign-in provider's credentials against its token endpoint (the result is kept)",
      middleware: guard,
      request: { params: providerParam },
      responses: {
        200: json(loginProvidersResponseSchema.extend({ result: loginProviderTestSchema }), 'Result'),
        ...errors(401, 404),
      },
    }),
    async (c) => c.json(await testLoginProvider(deps, currentUser(c), c.req.valid('param').provider), 200),
  );

  return r;
};
