// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  accountDeletionStatusSchema,
  accountExportLinkSchema,
  accountExportListSchema,
  accountExportSchema,
  pendingDeletionSchema,
  purgeAccountNowSchema,
  scheduleAccountDeletionSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { currentUser, requestMeta, requireAccount, requirePlatformOwner, requireUser } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { accountExportLink, listAccountExports, startAccountExport } from './account-export.service';
import {
  cancelDeletion,
  deletionStatus,
  listPendingDeletions,
  ownerCancelDeletion,
  ownerPurgeNow,
  scheduleDeletion,
} from './account-deletion.service';

const common = errors(400, 401, 403, 404, 409, 422, 429);
const tags = ['account'];

/**
 * Account export and deletion: Administration → General ("Export all data", "Delete the account")
 * and the owner console's list of accounts waiting for their deletion.
 */
export const accountDeletionRoutes = (deps: AppDeps) => {
  const scoped = [requireAccount(deps)];
  const owner = [requireUser(), requirePlatformOwner()];
  const actor = (c: Context<AppEnv>) => ({
    ctx: c.get('account'),
    user: currentUser(c),
    requestId: c.get('requestId'),
    sessionId: c.get('sessionId') ?? null,
    token: c.get('token') ?? null,
  });
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/account-export',
      tags,
      summary: "The account's latest full exports (admins)",
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(accountExportListSchema, 'Exports'), ...common },
    }),
    async (c) => c.json(await listAccountExports(deps, actor(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/account-export',
      tags,
      summary: 'Export all the account’s data to one ZIP (admins; built in the background, emailed when ready)',
      description:
        'Every board as an Excel workbook (items and subitems, updates on a second sheet), every doc as Markdown and HTML, every file in folders by board and item, and users.csv. Built in the background; the requester is emailed when it is ready and it stays downloadable for the platform’s export period (7 days by default). It reads as the requester: private boards and docs they are not in are left out and listed. 409 `export_in_progress` while another one is being built. Audited.',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 202: json(accountExportSchema, 'Started'), ...common },
    }),
    async (c) => c.json(await startAccountExport(deps, actor(c), requestMeta(c)), 202),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/account-export/{id}/download',
      tags,
      summary: 'A short-lived download link to a ready export (admins; audited)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(accountExportLinkSchema, 'Link'), ...common },
    }),
    async (c) => c.json(await accountExportLink(deps, actor(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/account-deletion',
      tags,
      summary: 'Whether the account is scheduled for deletion, and when',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(accountDeletionStatusSchema, 'Status'), ...common },
    }),
    async (c) => c.json(await deletionStatus(deps, actor(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/account-deletion',
      tags,
      summary: 'Schedule the account’s deletion (admins; the name typed again and a fresh two-factor code)',
      description:
        "Locks the account at once (like a closed account) and deletes all its data for good when the grace period ends (30 days by default); any admin can cancel meanwhile. `confirm_name` must repeat the account's name (422 `confirm_mismatch`); `code` is a fresh code from the authenticator app — without two-factor sign-in this answers 403 `step_up_two_factor_required`, a wrong code 422 `step_up_code_invalid`. Session only. Admins are emailed now and 7 days and 1 day before. Audited.",
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(scheduleAccountDeletionSchema) },
      responses: { 200: json(accountDeletionStatusSchema, 'Scheduled'), ...common },
    }),
    async (c) =>
      c.json(await scheduleDeletion(deps, actor(c), c.req.valid('json'), c.req.raw.headers, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/account-deletion/cancel',
      tags,
      summary: 'Cancel the scheduled deletion (admins) — the account opens again at once',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(accountDeletionStatusSchema, 'Cancelled'), ...common },
    }),
    async (c) => c.json(await cancelDeletion(deps, actor(c), requestMeta(c)), 200),
  );

  // ---- owner console ----

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/account-deletions',
      tags: ['platform'],
      summary: 'Accounts scheduled for deletion, soonest first',
      middleware: owner,
      responses: { 200: json(z.object({ data: z.array(pendingDeletionSchema) }), 'Accounts'), ...errors(401, 404) },
    }),
    async (c) => c.json({ data: await listPendingDeletions(deps) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/accounts/{id}/deletion/cancel',
      tags: ['platform'],
      summary: "Cancel an account's scheduled deletion",
      middleware: owner,
      request: { params: idParam },
      responses: { 200: json(okSchema, 'Cancelled'), ...errors(401, 404, 409) },
    }),
    async (c) => {
      await ownerCancelDeletion(deps, currentUser(c), c.req.valid('param').id, requestMeta(c));
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/accounts/{id}/deletion/now',
      tags: ['platform'],
      summary: 'Delete a scheduled account now, for good (its address typed again and the owner’s fresh 2FA code)',
      middleware: owner,
      request: { params: idParam, ...jsonBody(purgeAccountNowSchema) },
      responses: { 200: json(okSchema, 'Deleted (or queued)'), ...errors(401, 403, 404, 422, 429) },
    }),
    async (c) => {
      await ownerPurgeNow(
        deps,
        currentUser(c),
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.raw.headers,
        requestMeta(c),
      );
      return c.json({ ok: true as const }, 200);
    },
  );

  return r;
};
