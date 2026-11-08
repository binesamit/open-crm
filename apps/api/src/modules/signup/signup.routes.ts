// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import {
  domainJoinResponseSchema,
  rejectSignupSchema,
  signupAcceptedSchema,
  signupCompleteSchema,
  signupConfigSchema,
  signupIntentSchema,
  signupRequestListQuerySchema,
  signupRequestListSchema,
  signupRequestSchema,
  signupResendSchema,
  signupResultSchema,
  signupSettingsResponseSchema,
  signupStartSchema,
  signupVerifySchema,
  updateSignupSettingsSchema,
} from '@bines/shared';
import { z } from '@hono/zod-openapi';
import {
  actorOf,
  currentUser,
  requestMeta,
  requireAccount,
  requirePlatformOwner,
  requireUser,
} from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { getDomainJoin, verifyJoinDomain } from './signup.domain';
import { clearIntentCookie, intentCookie, SIGNUP_INTENT_MINUTES } from './signup.intent';
import {
  approveSignupRequest,
  completeSignup,
  listSignupRequestsFor,
  rejectSignupRequest,
  resendSignup,
  signupConfig,
  startSignup,
  startSignupIntent,
  verifySignup,
} from './signup.service';
import { getSignupSettings, updateSignupSettings } from './signup.settings';

const tags = ['signup'];
const ownerTags = ['platform'];
const ownerGuard = [requireUser(), requirePlatformOwner()];

/**
 * Self sign-up (D32). Public: the sign-up screen's config, start / resend / verify (email + password), intent /
 * complete (Google / Microsoft). Owner console: the settings, the requests queue, approve / reject. While the owner's
 * switch is off every public route but `config` answers 404.
 */
export const signupRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();
  const base = deps.env.BETTER_AUTH_URL ?? deps.env.WEB_ORIGIN;
  const secure = deps.env.NODE_ENV === 'production' && !base.startsWith('http://');

  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/signup/config',
      tags,
      summary: 'Public: whether self sign-up is open, and what its screen shows',
      description:
        'Always answers. `open: false` = sign-up is closed (switched off, or not available right now) and nothing else is filled.',
      responses: { 200: json(signupConfigSchema, 'Sign-up config') },
    }),
    async (c) => c.json(await signupConfig(deps), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/signup/start',
      tags,
      summary: 'Public: start a sign-up with email and password (sends the verification email)',
      description:
        'Always `{ok: true}` whoever the address belongs to; the email says "verify" or "you already have an account". 422 for an address the rules refuse or missing consent, 429 past a limit or the daily cap.',
      request: jsonBody(signupStartSchema),
      responses: { 200: json(signupAcceptedSchema, 'Accepted'), ...errors(400, 404, 422, 429) },
    }),
    async (c) => c.json(await startSignup(deps, c.req.valid('json'), requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/signup/resend',
      tags,
      summary: 'Public: send the verification email again',
      description: 'Always `{ok: true}`. Sent only after the cooldown and while the request is still waiting.',
      request: jsonBody(signupResendSchema),
      responses: { 200: json(signupAcceptedSchema, 'Accepted'), ...errors(400, 404, 429) },
    }),
    async (c) => c.json(await resendSignup(deps, c.req.valid('json'), requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/signup/verify',
      tags,
      summary: 'Public: the email link — create the account and sign in, or wait for approval',
      description:
        '`provisioned`: the account exists and the session cookie is set. `pending_approval`: the platform owner approves first. 404 `verification_invalid` for a used, expired or unknown link.',
      request: jsonBody(signupVerifySchema),
      responses: { 200: json(signupResultSchema, 'Verified'), ...errors(400, 404, 409, 422) },
    }),
    async (c) => {
      const { result, cookies } = await verifySignup(deps, c.req.valid('json'), requestMeta(c));
      for (const cookie of cookies) c.header('set-cookie', cookie, { append: true });
      return c.json(result, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/signup/intent',
      tags,
      summary: 'Public: before Google / Microsoft — keep the sign-up details for half an hour',
      description:
        'Runs the same checks as a start and sets a short-lived HttpOnly cookie; then the provider sign-in, then **complete**.',
      request: jsonBody(signupIntentSchema),
      responses: { 200: json(signupAcceptedSchema, 'Accepted'), ...errors(400, 404, 422, 429) },
    }),
    async (c) => {
      const { token } = await startSignupIntent(deps, c.req.valid('json'), requestMeta(c), SIGNUP_INTENT_MINUTES);
      if (token) c.header('set-cookie', intentCookie(token, secure), { append: true });
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/signup/complete',
      tags,
      summary: 'Signed in by Google / Microsoft: create the new account (or wait for approval)',
      description:
        'Needs the session the provider sign-in made and the intent cookie. The body brings what the intent did not hold (organisation, plan, consent); 422 `signup_details_required` (details.missing) while something is still lacking, and the intent stays. 409 `signup_already_registered` for someone who already had an account.',
      middleware: [requireUser()],
      request: jsonBody(signupCompleteSchema),
      responses: { 200: json(signupResultSchema, 'Completed'), ...errors(400, 401, 404, 409, 422) },
    }),
    async (c) => {
      const result = await completeSignup(
        deps,
        currentUser(c),
        c.req.header('cookie'),
        requestMeta(c),
        c.req.valid('json'),
      );
      c.header('set-cookie', clearIntentCookie(secure), { append: true });
      return c.json(result, 200);
    },
  );

  // ---- owner console ----

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/signup-settings',
      tags: ownerTags,
      summary: 'Self sign-up settings, and what is still missing before it can be turned on',
      middleware: ownerGuard,
      responses: { 200: json(signupSettingsResponseSchema, 'Settings'), ...errors(401, 404) },
    }),
    async (c) => c.json(await getSignupSettings(deps), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/signup-settings',
      tags: ownerTags,
      summary: 'Change the self sign-up settings (turning it on needs everything in place)',
      description:
        'Only what is sent changes. Turning it on while anything is missing answers 422 `signup_not_ready` with `details.missing`.',
      middleware: ownerGuard,
      request: jsonBody(updateSignupSettingsSchema),
      responses: { 200: json(signupSettingsResponseSchema, 'Saved'), ...errors(400, 401, 404, 422) },
    }),
    async (c) => c.json(await updateSignupSettings(deps, currentUser(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/signup-requests',
      tags: ownerTags,
      summary: 'Self sign-up requests (newest first)',
      middleware: ownerGuard,
      request: { query: signupRequestListQuerySchema },
      responses: { 200: json(signupRequestListSchema, 'Requests'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await listSignupRequestsFor(deps, c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/signup-requests/{id}/approve',
      tags: ownerTags,
      summary: 'Approve a sign-up request waiting for approval (creates the account)',
      middleware: ownerGuard,
      request: { params: idParam },
      responses: { 200: json(signupRequestSchema, 'Approved'), ...errors(401, 404, 409) },
    }),
    async (c) => c.json(await approveSignupRequest(deps, currentUser(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/signup-requests/{id}/reject',
      tags: ownerTags,
      summary: 'Reject a sign-up request (optionally block its domain)',
      middleware: ownerGuard,
      request: { params: idParam, ...jsonBody(rejectSignupSchema) },
      responses: { 200: json(signupRequestSchema, 'Rejected'), ...errors(400, 401, 404, 409) },
    }),
    async (c) =>
      c.json(
        await rejectSignupRequest(deps, currentUser(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)),
        200,
      ),
  );

  // ---- domain join (ה7): the account's admins, admin → security ----
  const accountGuard = [requireAccount(deps)];
  const djTags = ['security'];
  const domainParam = z.object({ domain: z.string().max(253) });
  const djResponses = { 200: json(domainJoinResponseSchema, 'DomainJoin') };
  r.openapi(
    createRoute({
      method: 'get',
      path: '/security/domain-join',
      tags: djTags,
      summary: "Domain join: each account domain's verification and whether people can join (admins)",
      middleware: accountGuard,
      request: { headers: accountHeader },
      responses: { ...djResponses, ...errors(401, 403) },
    }),
    async (c) => c.json(await getDomainJoin(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/security/domain-join/domains/{domain}/verify',
      tags: djTags,
      summary: "Verify an account domain: the admin's own address at it, else its DNS TXT record",
      middleware: accountGuard,
      request: { headers: accountHeader, params: domainParam },
      responses: { ...djResponses, ...errors(401, 403, 404, 409, 422) },
    }),
    async (c) => c.json(await verifyJoinDomain(deps, actorOf(c), c.req.valid('param').domain), 200),
  );

  return r;
};
