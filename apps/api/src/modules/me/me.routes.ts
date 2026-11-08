// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  ACCOUNT_HEADER,
  appearanceResponseSchema,
  authConfigSchema,
  CAPTCHA_TOKEN_HEADER,
  erasureRequestBodySchema,
  erasureRequestResultSchema,
  myErasureRequestSchema,
  setAppearanceSchema,
  favoriteBoardsSchema,
  favoritesSchema,
  invitationPreviewSchema,
  legalAcceptanceSchema,
  meSchema,
  myAccountSchema,
  myInvitationSchema,
  mySecuritySchema,
  profileSchema,
  setPasswordSchema,
  setFavoriteBoardsSchema,
  setFavoritesSchema,
  updateProfileSchema,
} from '@bines/shared';
import { currentUser, requestMeta, requireAccount, requireUser, actorOf } from '../../middleware/auth';
import { acceptLegal } from '../legal/legal.service';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  acceptInvitationByToken,
  acceptMyInvitation,
  listMyInvitations,
  previewInvitation,
} from '../invitations/invitations.service';
import { favoriteBoards, favorites, setFavoriteBoards, setFavorites } from '../users/favorites';
import { myProfile, updateMyProfile } from '../users/users.service';
import { forgotPassword, mySecurity, previewRecovery, setMyPassword } from '../users/recovery.service';
import { describeMe, myAccounts, rememberAccount } from './me.service';
import { myAppearance, setMyAppearance } from './appearance';
import { exportMyData } from '../users/personal-export';
import { myErasureRequest, requestErasure, withdrawErasure } from '../users/erasure-request';
import { personalExportSchema } from '../users/personal-export.schema';
import { loadPlatformSettings, platformBranding, platformSource } from '../platform/platform-settings';
import { platformPasswordMin } from '../../auth/password-policy';
import { assertCaptcha, authCaptchaConfig, platformCaptchaKeys } from '../captcha/captcha.service';
import { activeLoginProviders } from '../platform/login-providers';

const tokenBody = z.object({ token: z.string().min(20).max(200) });

/** Unscoped routes about the signed-in user (D12: no X-Account-Id needed) + the public invitation preview. */
export const meRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/auth/config',
      tags: ['me'],
      summary: "Public: which sign-in methods the login screen should offer, and the platform's branding",
      responses: { 200: json(authConfigSchema, 'Config') },
    }),
    async (c) =>
      c.json(
        {
          // Owner console → sign-in providers, else the environment.
          ...(await activeLoginProviders(deps)),
          // Email off (no transport): no email link to offer — password sign-in still works.
          magic_link: deps.emailEnabled !== false,
          password_min_length: await platformPasswordMin(db),
          branding: platformBranding(await loadPlatformSettings(db)),
          source: platformSource(await loadPlatformSettings(db), deps.env),
          captcha: await authCaptchaConfig(db),
        },
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/auth/me',
      tags: ['me'],
      summary: 'Signed-in identity; includes the account when X-Account-Id is sent',
      middleware: [requireUser()],
      responses: { 200: json(meSchema, 'Me'), ...errors(401) },
    }),
    async (c) => {
      // EXT-RT7: a token (API, MCP, extension) is bound to its account — it reads that account only, and never
      // learns which other account its person opened last.
      const token = c.get('token');
      if (!token) return c.json(await describeMe(deps, currentUser(c), c.req.header(ACCOUNT_HEADER)), 200);
      const asked = c.req.header(ACCOUNT_HEADER);
      const me = await describeMe(
        deps,
        currentUser(c),
        asked && asked !== token.accountId ? undefined : token.accountId,
      );
      // A token is not a sign-in: no account gate applies to it (requireAccount skips the SSO check for tokens).
      return c.json({ ...me, user: { ...me.user, sso_gate: [] }, last_account_id: null }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/accounts',
      tags: ['me'],
      summary: 'Accounts I am an active member of (account switcher)',
      middleware: [requireUser()],
      responses: { 200: json(z.object({ data: z.array(myAccountSchema) }), 'Accounts'), ...errors(401) },
    }),
    async (c) => c.json({ data: await myAccounts(db, currentUser(c)) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/me/last-account',
      tags: ['me'],
      summary: 'Remember the account `/` should open next time',
      middleware: [requireUser()],
      request: jsonBody(z.object({ account_id: z.string() })),
      responses: { 200: json(okSchema, 'Saved'), ...errors(401, 404) },
    }),
    async (c) => {
      await rememberAccount(db, currentUser(c), c.req.valid('json').account_id);
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/invitations',
      tags: ['me'],
      summary: 'Pending invitations addressed to my verified email',
      middleware: [requireUser()],
      responses: { 200: json(z.object({ data: z.array(myInvitationSchema) }), 'Invitations'), ...errors(401) },
    }),
    async (c) => c.json({ data: await listMyInvitations(db, currentUser(c)) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/me/invitations/{id}/accept',
      tags: ['me'],
      summary: 'Accept one of my pending invitations',
      middleware: [requireUser()],
      request: { params: idParam },
      responses: { 200: json(myAccountSchema, 'Joined account'), ...errors(401, 403, 404) },
    }),
    async (c) => c.json(await acceptMyInvitation(db, currentUser(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/invitations/preview',
      tags: ['invitations'],
      summary: 'Public: what an invitation link is for (token in the body, never in URLs we log)',
      request: jsonBody(tokenBody),
      responses: { 200: json(invitationPreviewSchema, 'Preview'), ...errors(404) },
    }),
    async (c) => c.json(await previewInvitation(db, c.req.valid('json').token), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/invitations/accept',
      tags: ['invitations'],
      summary: 'Accept an invitation link as the signed-in user (email must match)',
      middleware: [requireUser()],
      request: jsonBody(
        tokenBody.extend({
          /** the legal documents' versions the person agreed to on the sign-up screen. */
          accepted_legal: z.array(legalAcceptanceSchema).max(20).optional(),
        }),
      ),
      responses: { 200: json(myAccountSchema, 'Joined account'), ...errors(400, 401, 403, 404) },
    }),
    async (c) => {
      const body = c.req.valid('json');
      const joined = await acceptInvitationByToken(db, currentUser(c), body.token, requestMeta(c));
      if (body.accepted_legal?.length)
        await acceptLegal(deps, currentUser(c), body.accepted_legal, 'invite', requestMeta(c));
      return c.json(joined, 200);
    },
  );

  // ---- signing in without email (fix8): my password, and the preview of a one-time sign-in link ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/security',
      tags: ['me'],
      summary: 'How I can sign in: whether I have a password, and other providers (Google …)',
      middleware: [requireUser()],
      responses: { 200: json(mySecuritySchema, 'Security'), ...errors(401) },
    }),
    async (c) => c.json(await mySecurity(deps, currentUser(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/me/password',
      tags: ['me'],
      summary:
        'Set a first password (only when I have none; to change one use /api/auth/change-password with the current one)',
      middleware: [requireUser()],
      request: jsonBody(setPasswordSchema),
      responses: { 200: json(okSchema, 'Set'), ...errors(400, 401, 409, 422, 429) },
    }),
    async (c) =>
      c.json(await setMyPassword(deps, currentUser(c), c.req.valid('json').new_password, c.req.raw.headers), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/auth/forgot-password',
      tags: ['me'],
      summary:
        'Public: email a one-time link to choose a new password (same answer for unknown addresses; 503 email_not_sent when sending fails)',
      request: jsonBody(z.object({ email: z.email() })),
      responses: {
        200: json(okSchema, 'Requested'),
        ...errors(400, 429),
        503: { description: 'The email could not be sent' },
      },
    }),
    async (c) => {
      // Turnstile when the owner asks for it on "forgot password": the token in x-captcha-token.
      const meta = requestMeta(c);
      const keys = await platformCaptchaKeys(db, 'forgot_password');
      await assertCaptcha(deps.secrets, keys, c.req.header(CAPTCHA_TOKEN_HEADER), meta.ip);
      return c.json(await forgotPassword(deps, c.req.valid('json').email, meta), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/auth/recovery/preview',
      tags: ['me'],
      summary: 'Public: whose one-time sign-in link this is (token in the body, never in URLs we log)',
      request: jsonBody(tokenBody),
      responses: {
        200: json(
          z.object({ email: z.string(), expires_at: z.string(), password_min_length: z.number().int() }),
          'Preview',
        ),
        ...errors(400, 404),
      },
    }),
    async (c) => c.json(await previewRecovery(deps, c.req.valid('json').token), 200),
  );

  // ---- account-scoped: my profile (recorded in the current account) and my favourite boards (fix2) ----
  const scoped = [requireAccount(deps)];
  r.openapi(
    createRoute({
      method: 'get',
      path: '/users/me',
      tags: ['users'],
      summary: 'My profile: name, job title, phone, department, birthday, language, time zone, photo',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(profileSchema, 'Profile'), ...errors(400, 401, 403, 404) },
    }),
    async (c) => c.json(await myProfile(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/users/me',
      tags: ['users'],
      summary: 'Update my profile (any subset; an empty text clears the field)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(updateProfileSchema) },
      responses: { 200: json(profileSchema, 'Profile'), ...errors(400, 401, 403, 404, 422) },
    }),
    async (c) => c.json(await updateMyProfile(deps, actorOf(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/favorites',
      tags: ['me'],
      summary: 'My favourites in this account — boards, docs and dashboards in one list, in my order',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(favoritesSchema, 'Favourites'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await favorites(db, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/me/favorites',
      tags: ['me'],
      summary: 'Replace my favourites (the whole list, in order; what I cannot open is dropped)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(setFavoritesSchema) },
      responses: { 200: json(favoritesSchema, 'Favourites'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await setFavorites(db, actorOf(c), c.req.valid('json').items), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/favorite-boards',
      tags: ['me'],
      summary: 'My favourite boards in this account, in my order (only boards I can still open)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(favoriteBoardsSchema, 'Favourite boards'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await favoriteBoards(db, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/me/favorite-boards',
      tags: ['me'],
      summary: 'Replace my favourite boards (the whole list, in order; boards I cannot open are dropped)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(setFavoriteBoardsSchema) },
      responses: { 200: json(favoriteBoardsSchema, 'Favourite boards'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await setFavoriteBoards(db, actorOf(c), c.req.valid('json').board_ids), 200),
  );

  // Round 13: my text size and table density (every device; the account's default fills what I did not choose).
  const optionalAccount = z.object({ [ACCOUNT_HEADER]: z.string().optional() });
  // Privacy (GDPR art. 15 / 20; Israel Privacy Law §13): everything held about me, as one JSON file.
  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/export',
      tags: ['me'],
      summary:
        'Download my personal data (profile, accounts, consents, sign-ins, my updates, time, files, log) as JSON',
      middleware: [requireUser()],
      responses: { 200: json(personalExportSchema, 'Export'), ...errors(401, 403, 429) },
    }),
    async (c) => {
      const data = await exportMyData(db, currentUser(c), requestMeta(c));
      c.header('Content-Disposition', `attachment; filename="my-data-${data.generated_at.slice(0, 10)}.json"`);
      c.header('Cache-Control', 'no-store');
      return c.json(data, 200);
    },
  );
  // Privacy (GDPR art. 17; Israel Privacy Law §14): the person asks for their details to be deleted.
  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/erasure-request',
      tags: ['me'],
      summary: 'Whether I asked for my details to be deleted, and in which accounts',
      middleware: [requireUser()],
      responses: { 200: json(myErasureRequestSchema, 'Request'), ...errors(401) },
    }),
    async (c) => c.json(await myErasureRequest(db, currentUser(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/me/erasure-request',
      tags: ['me'],
      summary: 'Ask for my details to be deleted (the admins of each account are told; with no account, deleted now)',
      middleware: [requireUser()],
      request: jsonBody(erasureRequestBodySchema),
      responses: { 200: json(erasureRequestResultSchema, 'Result'), ...errors(400, 401, 403) },
    }),
    async (c) =>
      c.json(await requestErasure(deps, currentUser(c), c.req.valid('json').confirm_email, requestMeta(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/me/erasure-request',
      tags: ['me'],
      summary: 'Withdraw my pending request to delete my details',
      middleware: [requireUser()],
      responses: { 200: json(okSchema, 'Withdrawn'), ...errors(401) },
    }),
    async (c) => c.json(await withdrawErasure(db, currentUser(c), requestMeta(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/appearance',
      tags: ['me'],
      summary: 'My text size and table density (with the account default when X-Account-Id is sent)',
      middleware: [requireUser()],
      request: { headers: optionalAccount },
      responses: { 200: json(appearanceResponseSchema, 'Appearance'), ...errors(401) },
    }),
    async (c) => c.json(await myAppearance(db, currentUser(c), c.req.header(ACCOUNT_HEADER)), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/me/appearance',
      tags: ['me'],
      summary: 'Set my text size and / or table density (null = back to the default)',
      middleware: [requireUser()],
      request: { headers: optionalAccount, ...jsonBody(setAppearanceSchema) },
      responses: { 200: json(appearanceResponseSchema, 'Appearance'), ...errors(400, 401, 422) },
    }),
    async (c) =>
      c.json(await setMyAppearance(db, currentUser(c), c.req.valid('json'), c.req.header(ACCOUNT_HEADER)), 200),
  );

  return r;
};
