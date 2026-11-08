// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  accountSessionSchema,
  adminBoardSchema,
  auditPageSchema,
  auditQuerySchema,
  securitySettingsSchema,
  signOutResultSchema,
  transferBoardSchema,
  updateSecuritySchema,
  usageQuerySchema,
  usageSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { requestMeta, requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, idParam, json, jsonBody, okSchema, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { auditCsv, listAuditLog } from './audit.service';
import { getSecurity, listSessions, signOutAll, signOutSession, updateSecurity } from './security.service';
import { archiveAdminBoard, deleteAdminBoard, listAdminBoards, transferAdminBoard } from './tidy.service';
import { getUsage } from './usage.service';
import { tidyRoutes } from '../tidy/tidy.routes';

/**
 * Administration A4 + A5 (08 §5, §8, §9, §11): security, audit log, usage and tidy up. Admins only (the services
 * check); another account's sessions, boards and rows are 404.
 */
export const adminRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const middleware = [requireAccount(deps)];
  /** The session making the request (sessions are listed with "this device"; it is never signed out from here). */
  const withSession = async (c: Context<AppEnv>) => {
    const s = c.get('token') ? null : await deps.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    return { ...actorOf(c), sessionId: s?.session.id ?? null };
  };
  const r = new OpenAPIHono<AppEnv>();

  // ---- security ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/security',
      tags: ['security'],
      summary: 'Allowed domains, auto-join and the guest domain policy (admin)',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(securitySettingsSchema, 'Security settings'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await getSecurity(deps, actorOf(c), requestMeta(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/security',
      tags: ['security'],
      summary: 'Change security settings (admin) — audited as security.settings_changed',
      middleware,
      request: { headers: accountHeader, ...jsonBody(updateSecuritySchema) },
      responses: { 200: json(securitySettingsSchema, 'Security settings'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await updateSecurity(deps, actorOf(c), c.req.valid('json'), requestMeta(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/security/sessions',
      tags: ['security'],
      summary: "Live sign-ins of the account's people (admin)",
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(accountSessionSchema) }), 'Sessions'), ...COMMON_ERRORS },
    }),
    async (c) => c.json({ data: await listSessions(deps, await withSession(c)) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/security/sessions/sign-out-all',
      tags: ['security'],
      summary: "Sign out every sign-in of the account's people except mine (admin; sessions are global, D12)",
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(signOutResultSchema, 'Signed out'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await signOutAll(deps, await withSession(c), requestMeta(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/security/sessions/{id}',
      tags: ['security'],
      summary: 'Sign out one sign-in (admin; not your current one)',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(signOutResultSchema, 'Signed out'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await signOutSession(deps, await withSession(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  // ---- audit log ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/audit',
      tags: ['audit'],
      summary: 'The audit log (admin): filter by person, event and days; paged',
      middleware,
      request: { headers: accountHeader, query: auditQuerySchema },
      responses: { 200: json(auditPageSchema, 'Audit log'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await listAuditLog(db, actorOf(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/audit/export.csv',
      tags: ['audit'],
      summary: 'The filtered audit log as CSV (admin, ≤10,000 rows)',
      middleware,
      request: { headers: accountHeader, query: auditQuerySchema },
      responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: z.string() } } }, ...COMMON_ERRORS },
    }),
    async (c) =>
      new Response(await auditCsv(db, actorOf(c), c.req.valid('query')), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="audit.csv"',
        },
      }) as never,
  );

  // ---- usage ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/usage',
      tags: ['usage'],
      summary: 'Usage of the last N days (default 30), computed from the tables (admin)',
      middleware,
      request: { headers: accountHeader, query: usageQuerySchema },
      responses: { 200: json(usageSchema, 'Usage'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await getUsage(db, actorOf(c), c.req.valid('query')), 200),
  );

  // ---- tidy up ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/admin/boards',
      tags: ['tidy'],
      summary: 'Every board of the account with owners, items and last change (admin; private ones as metadata)',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(adminBoardSchema) }), 'Boards'), ...COMMON_ERRORS },
    }),
    async (c) => c.json({ data: await listAdminBoards(db, actorOf(c)) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/admin/boards/{id}/archive',
      tags: ['tidy'],
      summary: 'Archive a board (admin, audited)',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Archived'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await archiveAdminBoard(db, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/admin/boards/{id}',
      tags: ['tidy'],
      summary: 'Delete a board to the trash (admin, audited)',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await deleteAdminBoard(db, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/admin/boards/{id}/transfer-ownership',
      tags: ['tidy'],
      summary: 'Make an active member the owner of a board (admin, audited)',
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(transferBoardSchema) },
      responses: { 200: json(adminBoardSchema, 'Board'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(
        await transferAdminBoard(db, actorOf(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)),
        200,
      ),
  );

  // ---- scheduled cleaning (M8 ד13) ----
  r.route('/', tidyRoutes(deps));

  return r;
};
