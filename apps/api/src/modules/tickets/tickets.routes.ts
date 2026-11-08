// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  accountTicketSettingsSchema,
  createTicketSchema,
  ticketDetailSchema,
  ticketListSchema,
  ticketOptionsSchema,
  ticketRatingSchema,
  ticketReplySchema,
  updateAccountTicketSettingsSchema,
} from '@bines/shared';
import { requestMeta, requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, idParam, json, jsonBody, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  approveAccessRequest,
  closeTicket,
  createTicket,
  customerAttachment,
  declineAccessRequest,
  getAccountTicketSettings,
  getTicket,
  listMyTickets,
  rateTicket,
  reopenTicket,
  replyAsCustomer,
  ticketOptions,
  updateAccountTicketSettings,
} from './tickets.service';

/**
 * Support tickets, the customer's side: "My tickets" and the "?" menu's "open a ticket", inside an
 * account (a person's session only — never a token, never under a support grant).
 */
export const attachmentParams = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
  attachmentId: z.string().openapi({ param: { name: 'attachmentId', in: 'path' } }),
});
export const attachmentLinkSchema = z
  .object({ id: z.string(), name: z.string(), size: z.number(), mime: z.string(), download_url: z.string() })
  .openapi('TicketAttachmentLink');

export const ticketRoutes = (deps: AppDeps) => {
  const middleware = [requireAccount(deps)];
  const tags = ['support'];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/support/tickets/options',
      tags,
      summary: 'What the "open a ticket" form offers (categories, priorities, what is attached, may I open)',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(ticketOptionsSchema, 'Options'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await ticketOptions(deps, actorOf(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/support/tickets',
      tags,
      summary: 'My tickets (admins: the account’s), newest first',
      middleware,
      request: {
        headers: accountHeader,
        query: z.object({
          status: z.enum(['open', 'done']).optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: { 200: json(ticketListSchema, 'Tickets'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await listMyTickets(deps, actorOf(c), c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/support/tickets',
      tags,
      summary: 'Open a support ticket (with files and the context the person kept)',
      middleware,
      request: { headers: accountHeader, ...jsonBody(createTicketSchema) },
      responses: { 201: json(ticketDetailSchema, 'Opened'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await createTicket(deps, actorOf(c), c.req.valid('json')), 201),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/support/tickets/settings',
      tags,
      summary: 'Who may open tickets in this account and who sees them (admins)',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(accountTicketSettingsSchema, 'Settings'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await getAccountTicketSettings(deps, actorOf(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/support/tickets/settings',
      tags,
      summary: 'Change who may open tickets and who sees them (admins)',
      middleware,
      request: { headers: accountHeader, ...jsonBody(updateAccountTicketSettingsSchema) },
      responses: { 200: json(accountTicketSettingsSchema, 'Settings'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await updateAccountTicketSettings(deps, actorOf(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/support/tickets/{id}',
      tags,
      summary: 'A ticket with its public thread and access requests',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(ticketDetailSchema, 'Ticket'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await getTicket(deps, actorOf(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/support/tickets/{id}/messages',
      tags,
      summary: 'Answer on a ticket (a waiting or solved ticket opens again)',
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(ticketReplySchema) },
      responses: { 200: json(ticketDetailSchema, 'Ticket'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(
        await replyAsCustomer(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/support/tickets/{id}/close',
      tags,
      summary: 'Close a ticket (support access given from it ends)',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(ticketDetailSchema, 'Ticket'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await closeTicket(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/support/tickets/{id}/reopen',
      tags,
      summary: 'Open a solved or closed ticket again',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(ticketDetailSchema, 'Ticket'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await reopenTicket(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/support/tickets/{id}/rating',
      tags,
      summary: 'Rate the support (1–5) of a solved or closed ticket',
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(ticketRatingSchema) },
      responses: { 200: json(ticketDetailSchema, 'Ticket'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await rateTicket(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/support/tickets/{id}/attachments/{attachmentId}',
      tags,
      summary: 'A short-lived download link of a ticket’s file',
      middleware,
      request: { headers: accountHeader, params: attachmentParams },
      responses: { 200: json(attachmentLinkSchema, 'Link'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await customerAttachment(deps, actorOf(c), p.id, p.attachmentId), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/support/access-requests/{id}/approve',
      tags,
      summary: 'Let support in as it asked from the ticket (admins): one click creates the support grant',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(ticketDetailSchema, 'Ticket'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await approveAccessRequest(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/support/access-requests/{id}/decline',
      tags,
      summary: 'Decline support’s access request (admins)',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(ticketDetailSchema, 'Ticket'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await declineAccessRequest(deps, actorOf(c), c.req.valid('param').id), 200),
  );

  return r;
};
