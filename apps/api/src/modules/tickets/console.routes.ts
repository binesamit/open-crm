// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  createAccessRequestSchema,
  inviteSupportStaffSchema,
  putSlaPoliciesSchema,
  staffReplySchema,
  supportConsoleConfigSchema,
  supportReportSchema,
  supportStaffSchema,
  ticketArticleListSchema,
  ticketDetailSchema,
  ticketFilterSchema,
  ticketListSchema,
  updateHelpdeskSettingsSchema,
  updateSupportStaffSchema,
  updateTicketSchema,
  upsertCannedReplySchema,
  upsertCategorySchema,
  upsertQueueSchema,
  upsertSupportTagSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { currentUser, requestMeta, requireSupportConsole, requireUser } from '../../middleware/auth';
import { errors, idParam, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { attachmentLinkSchema, attachmentParams } from './tickets.routes';
import {
  cancelAccessRequest,
  consoleAttachment,
  consoleConfig,
  deleteTag,
  getConsoleTicket,
  inviteSupportStaff,
  listConsoleTickets,
  listSupportStaff,
  putSla,
  replyAsStaff,
  requestAccess,
  saveCanned,
  saveCategory,
  saveQueue,
  saveTag,
  supportReport,
  ticketArticleChoices,
  updateConsoleTicket,
  updateSettings,
  updateSupportStaff,
} from './console.service';

/**
 * The owner console's Support section: `/platform/support/*`, open to the platform owner and to
 * support staff (agent / lead) — 404 to everyone else (`requireSupportConsole`). Never with a token.
 */
export const supportConsoleRoutes = (deps: AppDeps) => {
  const middleware = [requireUser(), requireSupportConsole(deps)];
  const common = errors(400, 401, 403, 404, 409, 422);
  const tags = ['platform'];
  const staff = (c: Context<AppEnv>) => ({ user: currentUser(c), role: c.get('supportRole') ?? 'agent' });
  const r = new OpenAPIHono<AppEnv>();
  const config = json(supportConsoleConfigSchema, 'Configuration');
  const detail = json(ticketDetailSchema, 'Ticket');

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/config',
      tags,
      summary: 'The support console: my role, the settings, queues, categories, SLA, canned replies, tags, agents',
      description:
        "Everything the support console screen needs in one call: the caller's role (owner / lead / agent), helpdesk settings, queues, categories, SLA targets, canned replies, tags and support staff.",
      middleware,
      responses: { 200: config, ...common },
    }),
    async (c) => c.json(await consoleConfig(deps, staff(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/tickets',
      tags,
      summary: 'Tickets of every account, with filters (status, priority, category, queue, assignee, tag, SLA breach)',
      description:
        'Tickets of every account, filtered by status, priority, category, queue, assignee, tag or SLA breach. Each row carries the account, the requester and the SLA state.',
      middleware,
      request: { query: ticketFilterSchema },
      responses: { 200: json(ticketListSchema, 'Tickets'), ...common },
    }),
    async (c) => c.json(await listConsoleTickets(deps, staff(c), c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/tickets/{id}',
      tags,
      summary: 'A ticket: the whole thread (internal notes too), history and access requests',
      description:
        'One ticket with its whole thread — customer messages, staff replies and internal notes — its change history and the access requests made from it.',
      middleware,
      request: { params: idParam },
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await getConsoleTicket(deps, staff(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/support/tickets/{id}',
      tags,
      summary: 'Change a ticket: status, priority, category, queue, assignee, tags',
      description:
        "Changes a ticket's status, priority, category, queue, assignee or tags. Send only what changes; each change is recorded in the ticket history.",
      middleware,
      request: { params: idParam, ...jsonBody(updateTicketSchema) },
      responses: { 200: detail, ...common },
    }),
    async (c) =>
      c.json(
        await updateConsoleTicket(deps, staff(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support/tickets/{id}/messages',
      tags,
      summary: 'Reply to the customer, or write an internal note',
      description: 'Adds a message to a ticket: a reply the customer sees, or an internal note only support staff see.',
      middleware,
      request: { params: idParam, ...jsonBody(staffReplySchema) },
      responses: { 200: detail, ...common },
    }),
    async (c) =>
      c.json(await replyAsStaff(deps, staff(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/tickets/{id}/articles',
      tags,
      summary: 'Help articles the ticket’s customer may read, to attach to a reply (search by words)',
      middleware,
      request: {
        params: idParam,
        query: z.object({
          q: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        }),
      },
      responses: { 200: json(ticketArticleListSchema, 'Articles'), ...common },
    }),
    async (c) => c.json(await ticketArticleChoices(deps, staff(c), c.req.valid('param').id, c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/tickets/{id}/attachments/{attachmentId}',
      tags,
      summary: 'A short-lived download link of a file the customer attached',
      middleware,
      request: { params: attachmentParams },
      responses: { 200: json(attachmentLinkSchema, 'Link'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await consoleAttachment(deps, staff(c), p.id, p.attachmentId), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support/tickets/{id}/access-requests',
      tags,
      summary: "Ask the account's admins to let me in (view by default) — they approve with one click",
      description:
        "Asks the account's admins, from the ticket, for remote support access (view by default, for a set time). They approve with one click, which creates the support grant; until then nothing in the account opens.",
      middleware,
      request: { params: idParam, ...jsonBody(createAccessRequestSchema) },
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await requestAccess(deps, staff(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support/access-requests/{id}/cancel',
      tags,
      summary: 'Withdraw a pending access request',
      middleware,
      request: { params: idParam },
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await cancelAccessRequest(deps, staff(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/reports',
      tags,
      summary: 'Support reports: volume, first response, resolution, CSAT, per day / agent / category',
      middleware,
      request: { query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) },
      responses: { 200: json(supportReportSchema, 'Report'), ...common },
    }),
    async (c) => c.json(await supportReport(deps, staff(c), c.req.valid('query').days), 200),
  );

  // ---- configuration (leads and the owner) ----
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/support/settings',
      tags,
      summary: 'Helpdesk settings: business hours, access defaults, emails, CSAT, attached context, numbering',
      middleware,
      request: { ...jsonBody(updateHelpdeskSettingsSchema) },
      responses: { 200: config, ...common },
    }),
    async (c) => c.json(await updateSettings(deps, staff(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/platform/support/sla',
      tags,
      summary: 'SLA targets per priority (first response, resolution; business hours or around the clock)',
      middleware,
      request: { ...jsonBody(putSlaPoliciesSchema) },
      responses: { 200: config, ...common },
    }),
    async (c) => c.json(await putSla(deps, staff(c), c.req.valid('json').policies), 200),
  );

  const crud = (
    name: string,
    schema: z.ZodType,
    save: (s: ReturnType<typeof staff>, id: string | null, input: never) => Promise<unknown>,
  ) => {
    r.openapi(
      createRoute({
        method: 'post',
        path: `/platform/support/${name}`,
        tags,
        summary: `Add to the support ${name}`,
        middleware,
        request: { ...jsonBody(schema) },
        responses: { 200: config, ...common },
      }),
      async (c) => c.json((await save(staff(c), null, c.req.valid('json') as never)) as never, 200),
    );
    r.openapi(
      createRoute({
        method: 'patch',
        path: `/platform/support/${name}/{id}`,
        tags,
        summary: `Change one of the support ${name}`,
        middleware,
        request: { params: idParam, ...jsonBody(schema) },
        responses: { 200: config, ...common },
      }),
      async (c) => c.json((await save(staff(c), c.req.valid('param').id, c.req.valid('json') as never)) as never, 200),
    );
  };
  crud('queues', upsertQueueSchema, (s, id, input) => saveQueue(deps, s, id, input));
  crud('categories', upsertCategorySchema, (s, id, input) => saveCategory(deps, s, id, input));
  crud('canned-replies', upsertCannedReplySchema, (s, id, input) => saveCanned(deps, s, id, input));
  crud('tags', upsertSupportTagSchema, (s, id, input) => saveTag(deps, s, id, input));

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/support/tags/{id}',
      tags,
      summary: 'Delete a support tag (it leaves every ticket)',
      middleware,
      request: { params: idParam },
      responses: { 200: config, ...common },
    }),
    async (c) => c.json(await deleteTag(deps, staff(c), c.req.valid('param').id), 200),
  );

  // ---- staff (the platform owner) ----
  const staffList = json(z.object({ data: z.array(supportStaffSchema) }), 'Staff');
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/staff',
      tags,
      summary: 'Support staff (platform owner)',
      middleware,
      responses: { 200: staffList, ...common },
    }),
    async (c) => c.json(await listSupportStaff(deps, staff(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support/staff',
      tags,
      summary: 'Invite a support person by email (agent / lead) — they open only the Support section',
      description:
        "Invites a support person by email as an agent or a lead. They open only the owner console's Support section — no other part of the console, and no account's data without a grant.",
      middleware,
      request: { ...jsonBody(inviteSupportStaffSchema) },
      responses: { 200: staffList, ...common },
    }),
    async (c) => c.json(await inviteSupportStaff(deps, staff(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/support/staff/{id}',
      tags,
      summary: 'Change a support person’s role, or deactivate them',
      middleware,
      request: { params: idParam, ...jsonBody(updateSupportStaffSchema) },
      responses: { 200: staffList, ...common },
    }),
    async (c) => c.json(await updateSupportStaff(deps, staff(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  return r;
};
