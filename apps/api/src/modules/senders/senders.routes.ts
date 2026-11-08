// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  accountSenderStatusSchema,
  approveSenderRequestSchema,
  rejectSenderRequestSchema,
  senderRequestSchema,
  senderRequestsQuerySchema,
} from '@bines/shared';
import { currentUser, requestMeta, requireAccount, requirePlatformOwner, requireUser } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { accountSenderStatus, decideSenderRequest, listSenderRequests } from './senders.service';

/**
 * Custom senders (S-46): the admin reads the state of the account's requests; the platform owner lists them and
 * approves or rejects each one (owner console). The owner's routes answer 404 to anyone else (D12).
 */
export const senderRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();
  const owner = [requireUser(), requirePlatformOwner()];

  r.openapi(
    createRoute({
      method: 'get',
      path: '/accounts/me/sender-requests',
      tags: ['accounts'],
      summary: 'Approval state of the custom email sender name, Reply-To and SMS sender id (admin)',
      middleware: [requireAccount(deps)],
      request: { headers: accountHeader },
      responses: { 200: json(accountSenderStatusSchema, 'Sender requests'), ...errors(401, 403, 404, 423) },
    }),
    async (c) => c.json(await accountSenderStatus(deps.db, c.get('account')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/sender-requests',
      tags: ['platform'],
      summary: 'Custom senders waiting for approval (or all recent ones)',
      middleware: owner,
      request: { query: senderRequestsQuerySchema },
      responses: { 200: json(z.object({ data: z.array(senderRequestSchema) }), 'Requests'), ...errors(401, 404) },
    }),
    async (c) => c.json(await listSenderRequests(deps.db, c.req.valid('query').status), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/sender-requests/{id}/approve',
      tags: ['platform'],
      summary: 'Approve a custom sender: it takes effect in the account',
      middleware: owner,
      request: { params: idParam, ...jsonBody(approveSenderRequestSchema) },
      responses: { 200: json(senderRequestSchema, 'Approved'), ...errors(400, 401, 404, 409) },
    }),
    async (c) =>
      c.json(
        await decideSenderRequest(
          deps,
          currentUser(c),
          c.req.valid('param').id,
          'approved',
          c.req.valid('json').reason ?? null,
          requestMeta(c),
        ),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/sender-requests/{id}/reject',
      tags: ['platform'],
      summary: 'Reject a custom sender, with a reason (the account keeps its current sender)',
      middleware: owner,
      request: { params: idParam, ...jsonBody(rejectSenderRequestSchema) },
      responses: { 200: json(senderRequestSchema, 'Rejected'), ...errors(400, 401, 404, 409) },
    }),
    async (c) =>
      c.json(
        await decideSenderRequest(
          deps,
          currentUser(c),
          c.req.valid('param').id,
          'rejected',
          c.req.valid('json').reason,
          requestMeta(c),
        ),
        200,
      ),
  );

  return r;
};
