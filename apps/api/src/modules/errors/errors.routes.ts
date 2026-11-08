// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  accountHealthFilterSchema,
  accountHealthSchema,
  attachErrorSchema,
  clientErrorAnswerSchema,
  clientErrorReportSchema,
  errorAccountsSchema,
  errorAlertListSchema,
  errorDetailSchema,
  errorFilterSchema,
  errorHubConfigSchema,
  errorListSchema,
  errorTicketSchema,
  updateErrorEventSchema,
  updateErrorHubSettingsSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { currentUser, requireAccount, requireSupportConsole, requireUser } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  accountHealth,
  attachErrorToTicket,
  createTicketFromError,
  getErrorDetail,
  hubConfig,
  listErrorAccounts,
  listErrors,
  myAlerts,
  readMyAlerts,
  reportClientErrors,
  updateError,
  updateHubSettings,
} from './errors.service';

/**
 * Errors & health. `/platform/errors/*`: the owner console's section, for the platform owner and
 * support staff (404 to everyone else, never with a token). `/account-health`: the account's own Health page
 * (admins). `/client-errors`: the browser's automatic error reports. Both account-side routes are a person's
 * session only (lib/scopes.ts).
 */
export const errorRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();
  const hub = [requireUser(), requireSupportConsole(deps)];
  const common = errors(400, 401, 403, 404, 409, 422);
  const tags = ['platform'];
  const staff = (c: Context<AppEnv>) => ({ user: currentUser(c), role: c.get('supportRole') ?? 'agent' });
  const detail = json(errorDetailSchema, 'Error');
  const config = json(errorHubConfigSchema, 'Configuration');

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/errors/config',
      tags,
      summary: 'Errors hub: my role, the settings, support people (assignees) and accounts (filters)',
      middleware: hub,
      responses: { 200: config, ...common },
    }),
    async (c) => c.json(await hubConfig(deps, staff(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/errors/settings',
      tags,
      summary: 'Errors hub settings: sources, problem skips, retention, auto-resolve, alerts, account page, GlitchTip',
      middleware: hub,
      request: jsonBody(updateErrorHubSettingsSchema),
      responses: { 200: config, ...common },
    }),
    async (c) => c.json(await updateHubSettings(deps, staff(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/errors',
      tags,
      summary:
        'Errors of every account: filters (source, severity, status, account, assignee), views (recurring, spikes)',
      middleware: hub,
      request: { query: errorFilterSchema },
      responses: { 200: json(errorListSchema, 'Errors'), ...common },
    }),
    async (c) => c.json(await listErrors(deps, staff(c), c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/errors/accounts',
      tags,
      summary: 'Errors by account: open, critical, occurrences in 24 hours, last seen',
      middleware: hub,
      responses: { 200: json(errorAccountsSchema, 'Accounts'), ...common },
    }),
    async (c) => c.json(await listErrorAccounts(deps), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/errors/alerts',
      tags,
      summary: 'The console bell: error alerts sent to me',
      middleware: hub,
      responses: { 200: json(errorAlertListSchema, 'Alerts'), ...common },
    }),
    async (c) => c.json(await myAlerts(deps, staff(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/errors/alerts/read',
      tags,
      summary: 'Mark my error alerts read',
      middleware: hub,
      responses: { 200: json(errorAlertListSchema, 'Alerts'), ...common },
    }),
    async (c) => c.json(await readMyAlerts(deps, staff(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/errors/{id}',
      tags,
      summary: 'An error: metadata, 24 hours of occurrences; the run trace and account link need an active grant',
      middleware: hub,
      request: { params: idParam },
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await getErrorDetail(deps, staff(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/errors/{id}',
      tags,
      summary: 'Acknowledge / resolve / ignore / reopen an error, assign it, mute it until a time, note',
      middleware: hub,
      request: { params: idParam, ...jsonBody(updateErrorEventSchema) },
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await updateError(deps, staff(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/errors/{id}/ticket',
      tags,
      summary: "Open a support ticket in the error's account (an internal note with the error)",
      middleware: hub,
      request: { params: idParam, ...jsonBody(errorTicketSchema) },
      responses: {
        200: json(
          z.object({
            ticket: z.object({ id: z.string(), number: z.number().int(), url: z.string() }),
            detail: errorDetailSchema,
          }),
          'Ticket',
        ),
        ...common,
      },
    }),
    async (c) => c.json(await createTicketFromError(deps, staff(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/errors/{id}/attach',
      tags,
      summary: 'Link the error to an existing ticket of the same account',
      middleware: hub,
      request: { params: idParam, ...jsonBody(attachErrorSchema) },
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await attachErrorToTicket(deps, staff(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  // ---- the account side ----

  r.openapi(
    createRoute({
      method: 'get',
      path: '/account-health',
      tags: ['admin'],
      summary: "The account's own errors (admins): what failed, how often, open or resolved",
      middleware: [requireAccount(deps)],
      request: { headers: accountHeader, query: accountHealthFilterSchema },
      responses: { 200: json(accountHealthSchema, 'Health'), ...common },
    }),
    async (c) => c.json(await accountHealth(deps, c.get('account'), c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/client-errors',
      tags: ['me'],
      summary: "The browser's errors (sampled, scrubbed, limited per person)",
      middleware: [requireUser()],
      request: jsonBody(clientErrorReportSchema),
      responses: { 200: json(clientErrorAnswerSchema, 'Accepted'), ...errors(400, 401, 422) },
    }),
    async (c) => c.json(await reportClientErrors(deps, currentUser(c), c.req.valid('json')), 200),
  );

  return r;
};
