// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  createAccountSchema,
  deleteAccountSchema,
  invitationSchema,
  inviteAdminSchema,
  ownerRecoveryLinkSchema,
  platformInviteSchema,
  resendInvitationQuerySchema,
  platformAccountSchema,
  recoveryLinkSchema,
  suspendAccountSchema,
  updatePlatformAccountSchema,
  platformSettingsResponseSchema as platformSettingsResponse,
  updatePlatformSettingsSchema,
  createStarterKitSchema,
  kitSourceBoardsSchema,
  starterKitDetailSchema,
  updateStarterKitSchema,
  aiPriceRowSchema,
  createAiPriceSchema,
  updateAiPriceSchema,
  publicAddressInfoSchema,
} from '@bines/shared';
import * as aiPrices from '../ai/prices.service';
import { getPlatformSettings, updatePlatformSettings } from './platform-settings';
import { publicAddress } from './public-address';
import { currentUser, requestMeta, requirePlatformOwner, requireUser } from '../../middleware/auth';
import { errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  createPlatformAccount,
  deletePlatformAccount,
  inviteAccountAdmin,
  listPlatformAccounts,
  listPlatformInvitations,
  platformCancelInvitation,
  platformInvite,
  platformResendInvitation,
  sendDiagnostic,
  setAccountSuspended,
  updatePlatformAccount,
} from './platform.service';
import { ownerRecoveryLink, ownerResetTwoFactor } from '../users/recovery.service';
import * as kits from './starter-kits.service';

const guard = [requireUser(), requirePlatformOwner()];
const tags = ['platform'];
const invitationResult = z.object({ invitation: invitationSchema, emailed: z.boolean() });
const invitationParams = idParam.extend({
  invitationId: z.string().openapi({ param: { name: 'invitationId', in: 'path' } }),
});

/** Owner console API (D12, 06 §2.1a). Answers 404 to anyone who is not a platform owner. */
export const platformRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/accounts',
      tags,
      summary: 'All accounts with member counts',
      description:
        'Every account on the platform with its status (active / suspended) and member count. `q` searches the name and slug; `status` filters. Deleted accounts are not listed.',
      middleware: guard,
      request: {
        query: z.object({ q: z.string().max(100).optional(), status: z.enum(['active', 'suspended']).optional() }),
      },
      responses: { 200: json(z.object({ data: z.array(platformAccountSchema) }), 'Accounts'), ...errors(401, 404) },
    }),
    async (c) => c.json({ data: await listPlatformAccounts(deps, currentUser(c), c.req.valid('query')) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/accounts',
      tags,
      summary: 'Create an account and invite its first admin',
      description:
        'Creates an account (name, unique slug, time zone, currency) from a starter kit (`template_set`, default `empty`) and invites its first admin by email. Answers the account and the invitation, with `emailed: false` when the email could not be sent (copy the link instead). Audited as `account.created`. 409 when the slug is taken.',
      middleware: guard,
      request: jsonBody(createAccountSchema),
      responses: {
        201: json(invitationResult.extend({ account: platformAccountSchema }), 'Created'),
        ...errors(400, 401, 404, 409),
      },
    }),
    async (c) => c.json(await createPlatformAccount(deps, currentUser(c), c.req.valid('json'), requestMeta(c)), 201),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/accounts/{id}',
      tags,
      summary: 'Rename an account or change its slug',
      description:
        "Changes an account's name and / or slug. Send only what changes. 409 when the new slug is taken. Audited.",
      middleware: guard,
      request: { params: idParam, ...jsonBody(updatePlatformAccountSchema) },
      responses: { 200: json(okSchema, 'Updated'), ...errors(400, 401, 404, 409) },
    }),
    async (c) => {
      await updatePlatformAccount(deps, currentUser(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c));
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/accounts/{id}/suspend',
      tags,
      summary: 'Suspend an account (every scoped request answers 423)',
      description:
        'Suspends an account with a reason: from then on every request inside it (REST, MCP, the docs socket) answers 423; nothing is deleted. Audited as `account.suspended`. Undo with **Lift a suspension**.',
      middleware: guard,
      request: { params: idParam, ...jsonBody(suspendAccountSchema) },
      responses: { 200: json(okSchema, 'Suspended'), ...errors(400, 401, 404) },
    }),
    async (c) => {
      const { reason } = c.req.valid('json');
      await setAccountSuspended(deps, currentUser(c), c.req.valid('param').id, true, reason, requestMeta(c));
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/accounts/{id}/restore',
      tags,
      summary: 'Lift a suspension',
      description:
        "Lifts an account's suspension: its people and tokens work again at once. Audited as `account.restored`.",
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(okSchema, 'Restored'), ...errors(401, 404) },
    }),
    async (c) => {
      await setAccountSuspended(deps, currentUser(c), c.req.valid('param').id, false, undefined, requestMeta(c));
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/accounts/{id}',
      tags,
      summary: 'Soft-delete an account',
      description:
        "Deletes an account: it disappears from every list at once. Its data is purged for good by the hourly sweep once the grace period (`account_deletion.grace_days`) passed — only when the owner turned on `account_deletion.purge_console_deleted` (off by default); otherwise the row stays soft-deleted. The body must repeat the account's slug (`confirm_slug`) — anything else answers 422 `confirm_mismatch`. Audited as `account.deleted`.",
      middleware: guard,
      request: { params: idParam, ...jsonBody(deleteAccountSchema) },
      responses: { 200: json(okSchema, 'Deleted'), ...errors(401, 404, 422) },
    }),
    async (c) => {
      await deletePlatformAccount(
        deps,
        currentUser(c),
        c.req.valid('param').id,
        c.req.valid('json').confirm_slug,
        requestMeta(c),
      );
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/accounts/{id}/invite-admin',
      tags,
      summary: 'Invite (or re-invite) an admin to an account',
      description:
        "Invites a person as an admin of the account by email (or sends the invitation again). Follows the back-door rule: an invitation to a platform owner's own address is allowed only as an active admin of the account, or for the first admin of an account nobody is in yet.",
      middleware: guard,
      request: { params: idParam, ...jsonBody(inviteAdminSchema) },
      responses: { 200: json(invitationResult, 'Invited'), ...errors(400, 401, 404) },
    }),
    async (c) =>
      c.json(await inviteAccountAdmin(deps, currentUser(c), c.req.valid('param').id, c.req.valid('json').email), 200),
  );

  // Invitations of an account: list, invite anyone, re-send / copy link, cancel — the back-door rule holds.
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/accounts/{id}/invitations',
      tags,
      summary: "An account's open invitations (pending and expired) with status and inviter",
      description:
        "The account's open invitations — status `link` (never emailed), `sent`, `failed`, `opened` or `expired` — with role, inviter and dates. Accepted and cancelled invitations are not listed.",
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(z.object({ data: z.array(invitationSchema) }), 'Invitations'), ...errors(401, 404) },
    }),
    async (c) => c.json({ data: await listPlatformInvitations(deps, c.req.valid('param').id) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/accounts/{id}/invitations',
      tags,
      summary: 'Invite anyone to an account (any role), by email or as a link to copy',
      description:
        "Invites anyone to the account in any role (default `admin`). With `send_email: false` nothing is emailed and the answer carries the link to copy. The back-door rule holds (403 for a link to the owner's own address outside it). Audited as the owner's (`via: platform_owner`).",
      middleware: guard,
      request: { params: idParam, ...jsonBody(platformInviteSchema) },
      responses: { 200: json(invitationResult, 'Invited'), ...errors(400, 401, 403, 404, 429) },
    }),
    async (c) => c.json(await platformInvite(deps, currentUser(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  for (const [action, linkOnly] of [
    ['resend', false],
    ['link', true],
  ] as const)
    r.openapi(
      createRoute({
        method: 'post',
        path: `/platform/accounts/{id}/invitations/{invitationId}/${action}`,
        tags,
        summary: linkOnly
          ? 'A fresh link of an invitation to copy — nothing is emailed; the old link stops working'
          : 'Email an invitation again with a fresh link; the old link stops working',
        middleware: guard,
        request: { params: invitationParams, query: resendInvitationQuerySchema },
        responses: { 200: json(invitationResult, 'Invitation'), ...errors(401, 403, 404, 429) },
      }),
      async (c) => {
        const p = c.req.valid('param');
        return c.json(
          await platformResendInvitation(deps, currentUser(c), p.id, p.invitationId, {
            linkOnly,
            expiresInDays: c.req.valid('query').expires_in_days,
          }),
          200,
        );
      },
    );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/accounts/{id}/invitations/{invitationId}',
      tags,
      summary: 'Cancel an invitation: its link stops working at once',
      middleware: guard,
      request: { params: invitationParams },
      responses: { 200: json(okSchema, 'Cancelled'), ...errors(401, 404) },
    }),
    async (c) => {
      const p = c.req.valid('param');
      await platformCancelInvitation(deps, currentUser(c), p.id, p.invitationId, requestMeta(c));
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/accounts/{id}/recovery-link',
      tags,
      summary: 'A one-time sign-in / new-password link (1 hour) for anyone in an account — copied, never emailed',
      description:
        'A single-use link (1 hour) that lets a member of the account set a new password and sign in — for when email does not reach them. Shown once, never emailed. Allowed only while the owner is an active admin of the account or holds an active **edit** support grant; otherwise 403 `support_grant_required` (use the emergency recovery path). Rate limited; audited.',
      middleware: guard,
      request: { params: idParam, ...jsonBody(ownerRecoveryLinkSchema) },
      responses: { 200: json(recoveryLinkSchema, 'Link'), ...errors(400, 401, 403, 404, 429) },
    }),
    async (c) =>
      c.json(
        await ownerRecoveryLink(
          deps,
          currentUser(c),
          c.req.valid('param').id,
          c.req.valid('json').email,
          requestMeta(c),
        ),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/accounts/{id}/reset-2fa',
      tags,
      summary: "Turn a member's second factor off (lost phone) from the owner console",
      description:
        'For people an account admin may not touch — active in more than one account (their second factor guards those too). Allowed only while the owner is an active admin of the account or holds an active **edit** support grant; otherwise 403 `support_grant_required`. 409 `two_factor_not_enabled` when they have none. Audited in the account as `auth.2fa.reset` (via the owner console).',
      middleware: guard,
      request: { params: idParam, ...jsonBody(ownerRecoveryLinkSchema) },
      responses: { 200: json(okSchema, 'Reset'), ...errors(400, 401, 403, 404, 409) },
    }),
    async (c) =>
      c.json(
        await ownerResetTwoFactor(
          deps,
          currentUser(c),
          c.req.valid('param').id,
          c.req.valid('json').email,
          requestMeta(c),
        ),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/diagnostics/notify',
      tags,
      summary: 'Send a test email or SMS (checks Resend / TextMe configuration)',
      description:
        "Sends a test email or SMS to `to` to check that this environment's providers (Resend, TextMe) are configured. With `account_id` it sends as that account would (its sender name / SMS sender id). Answers the provider's message id, or 503 `unavailable` with the provider's error.",
      middleware: guard,
      request: jsonBody(
        z.object({
          channel: z.enum(['email', 'sms']),
          to: z.string().min(5).max(320),
          /** Send as this account would (its sender name / SMS sender id); omitted = as the platform. */
          account_id: z.string().max(26).optional(),
        }),
      ),
      responses: {
        200: json(z.object({ ok: z.literal(true), id: z.string().nullable() }), 'Sent'),
        ...errors(400, 401, 404),
      },
    }),
    async (c) => c.json(await sendDiagnostic(deps, currentUser(c), c.req.valid('json')), 200),
  );

  // M11: the platform's public address, for the web app's copyable links (forms, webhooks, item links). Public.
  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/address',
      tags,
      summary: "Public: the platform's public address (app and API origins) that links are built on",
      responses: { 200: json(publicAddressInfoSchema, 'Address') },
    }),
    async (c) => {
      const a = await publicAddress(deps);
      return c.json({ web: a.web, api: a.api }, 200, { 'Cache-Control': 'public, max-age=60' });
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/settings',
      tags,
      summary: 'Platform settings: product name, platform email / SMS sender, API-token budgets',
      description:
        "Every platform setting with the fallback each empty field uses (the env): product name, the platform's email / SMS sender, the API reference's logo and colour, API token budgets, public address, password policy and more.",
      middleware: guard,
      responses: { 200: json(platformSettingsResponse, 'Settings'), ...errors(401, 404) },
    }),
    async (c) => c.json(await getPlatformSettings(deps, currentUser(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/settings',
      tags,
      summary: 'Update platform settings (only what is sent; null = back to the default)',
      description:
        'Changes platform settings. Only the fields sent change; `null` sets a field back to its default (the env value). Effective within about 30 seconds in every process (the settings are cached briefly).',
      middleware: guard,
      request: jsonBody(updatePlatformSettingsSchema),
      responses: { 200: json(platformSettingsResponse, 'Settings'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await updatePlatformSettings(deps, currentUser(c), c.req.valid('json')), 200),
  );

  // --- the AI price table: USD per 1M tokens per provider + model / pattern ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/ai-prices',
      tags,
      summary: 'The AI price table (USD per 1M tokens per provider and model or pattern)',
      middleware: guard,
      responses: { 200: json(z.object({ data: z.array(aiPriceRowSchema) }), 'Prices'), ...errors(401, 404) },
    }),
    async (c) => c.json(await aiPrices.listAiPrices(deps), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/ai-prices',
      tags,
      summary: 'Add a price (a provider or * and an exact model id or a pattern with *)',
      middleware: guard,
      request: jsonBody(createAiPriceSchema),
      responses: { 201: json(aiPriceRowSchema, 'Created'), ...errors(400, 401, 404, 409) },
    }),
    async (c) => c.json(await aiPrices.createAiPrice(deps, currentUser(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/ai-prices/{id}',
      tags,
      summary: 'Change a price',
      middleware: guard,
      request: { params: idParam, ...jsonBody(updateAiPriceSchema) },
      responses: { 200: json(aiPriceRowSchema, 'Updated'), ...errors(400, 401, 404, 409) },
    }),
    async (c) =>
      c.json(await aiPrices.updateAiPrice(deps, currentUser(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/ai-prices/{id}',
      tags,
      summary: 'Remove a price (models it priced become "price unknown" unless another row matches)',
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(okSchema, 'Removed'), ...errors(401, 404) },
    }),
    async (c) => c.json(await aiPrices.deleteAiPrice(deps, currentUser(c), c.req.valid('param').id), 200),
  );

  // --- starter kits as data (M11 stage 3): defined, previewed and versioned in the owner console ----
  const keyParam = z.object({
    key: z
      .string()
      .max(48)
      .openapi({ param: { name: 'key', in: 'path' } }),
  });
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/starter-kits/{key}',
      tags,
      summary:
        'A starter kit: what a new account gets from it (workspace, folders, boards, automations) and its versions',
      middleware: guard,
      request: { params: keyParam },
      responses: { 200: json(starterKitDetailSchema, 'Starter kit'), ...errors(401, 404) },
    }),
    async (c) => c.json(await kits.kitDetail(deps.db, c.req.valid('param').key), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/accounts/{id}/kit-boards',
      tags,
      summary: 'Boards of an account I am an admin of, to save as a starter kit',
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(kitSourceBoardsSchema, 'Boards'), ...errors(401, 403, 404) },
    }),
    async (c) => c.json(await kits.kitSourceBoards(deps.db, currentUser(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/starter-kits',
      tags,
      summary: 'Save boards of an account (as templates, with their folders and automations) as a starter kit',
      middleware: guard,
      request: jsonBody(createStarterKitSchema),
      responses: { 201: json(starterKitDetailSchema, 'Created'), ...errors(400, 401, 403, 404, 409, 422) },
    }),
    async (c) => c.json(await kits.createKitFromBoards(deps.db, currentUser(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/starter-kits/{key}',
      tags,
      summary: 'Edit a starter kit (name, workspace name, folders, boards, default); a new version',
      middleware: guard,
      request: { params: keyParam, ...jsonBody(updateStarterKitSchema) },
      responses: { 200: json(starterKitDetailSchema, 'Starter kit'), ...errors(400, 401, 404, 422) },
    }),
    async (c) =>
      c.json(await kits.updateKit(deps.db, currentUser(c), c.req.valid('param').key, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/starter-kits/{key}',
      tags,
      summary: 'Remove a starter kit from the catalog (accounts made with it keep everything)',
      middleware: guard,
      request: { params: keyParam },
      responses: { 200: json(okSchema, 'Removed'), ...errors(401, 404) },
    }),
    async (c) => c.json(await kits.deleteKit(deps.db, c.req.valid('param').key), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/starter-kits/{key}/versions/{versionId}/restore',
      tags,
      summary: 'Restore an earlier version of a starter kit (as a new version)',
      middleware: guard,
      request: {
        params: keyParam.extend({
          versionId: z
            .string()
            .max(26)
            .openapi({ param: { name: 'versionId', in: 'path' } }),
        }),
      },
      responses: { 200: json(starterKitDetailSchema, 'Starter kit'), ...errors(401, 404) },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await kits.restoreKitVersion(deps.db, currentUser(c), p.key, p.versionId), 200);
    },
  );

  return r;
};
