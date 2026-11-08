// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type CreateTicket,
  createTicketSchema,
  type HelpdeskSettings,
  newId,
  TICKET_PRIORITIES,
  type TicketContext,
  type TicketDetail,
  type TicketOptions,
  type TicketPriority,
  type TicketStatus,
} from '@bines/shared';
import type { AccountContext, AppDeps, RequestMeta, SessionUser } from '../../types';
import { isInlineSafeMime } from '../../lib/storage';
import { findAccountById, getAccountSettings } from '../accounts/accounts.repo';
import { ownUploadedAssets } from '../files/files.service';
import { loadPlatformSettings } from '../platform/platform-settings';
import { createSupportGrant, grantOptions } from '../support/support.service';
import { securityOf } from '../admin/security.service';
import { changeStatus } from './tickets.lifecycle';
import { accessRequestsOf, contextOf, summaryOf, threadOf, withTags } from './tickets.dto';
import { notifyAccessDecision, notifyCreated, notifyStaff } from './tickets.notify';
import { slaDue } from './tickets.sla';
import { loadHelpSettings } from '../help/help.settings';
import { loadAccountTicketSettings, loadHelpdeskSettings, saveAccountTicketSettings } from './tickets.settings';
import {
  decideAccessRequest,
  defaultQueue,
  findAccessRequest,
  findAttachment,
  findCategory,
  findSla,
  findStaffRoleOf,
  findTicket,
  findUser,
  insertAttachments,
  insertEvent,
  insertMessage,
  insertTicket,
  listCategories,
  nextTicketNumber,
  queryTickets,
  type TicketRow,
  updateTicketRow,
} from './tickets.repo';

/**
 * Support tickets — the customer's side: account members open tickets (who may is the account's
 * setting), see their tickets ("My tickets"; admins see the account's), reply, close / reopen and rate. Internal
 * notes never leave the console. Account admins approve or decline support's access requests from the ticket: one
 * click creates a grant of the existing kind (`email` grantee = the support person), linked to the ticket.
 * Nobody inside the account by a support grant may use any of this.
 */
type Deps = Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger' | 'storage' | 'auth'>;
export type CustomerActor = { ctx: AccountContext; user: SessionUser; requestId?: string };

const assertCustomer = (a: CustomerActor) => {
  if (a.ctx.support) throw new AppError('forbidden', 'support_not_allowed');
  if (a.ctx.role === 'guest') throw new AppError('forbidden', 'tickets_not_for_guests');
};

const seesAll = (a: CustomerActor, members: 'own' | 'all') => a.ctx.role === 'admin' || members === 'all';

const mayOpen = (a: CustomerActor, who: 'admins' | 'members', settings: HelpdeskSettings) =>
  settings.enabled && !a.ctx.support && a.ctx.role !== 'guest' && (who === 'members' || a.ctx.role === 'admin');

/** GET /support/tickets/options — what the "open a ticket" form offers this person. */
export const ticketOptions = async (deps: Pick<Deps, 'db'>, a: CustomerActor): Promise<TicketOptions> => {
  assertCustomer(a);
  const [settings, account, categories, help] = await Promise.all([
    loadHelpdeskSettings(deps.db),
    loadAccountTicketSettings(deps.db, a.ctx.accountId),
    listCategories(deps.db),
    loadHelpSettings(deps.db),
  ]);
  return {
    enabled: settings.enabled,
    may_open: mayOpen(a, account.who_can_open, settings),
    categories: categories
      .filter((c) => !c.archivedAt)
      .map((c) => ({
        id: c.id,
        name: c.name,
        default_priority: (c.defaultPriority as TicketPriority | null) ?? null,
      })),
    priorities: [...TICKET_PRIORITIES],
    default_priority: settings.default_priority,
    context: settings.context,
    csat: settings.csat.enabled,
    // The knowledge center: articles before the form when the helpdesk and the help center want it.
    suggest_articles: settings.suggest_articles && help.enabled && help.flow.show_articles,
    settings: account,
    is_admin: a.ctx.role === 'admin',
  };
};

/** Keeps only what the platform lets the app attach (each item a setting) — and never more errors than allowed. */
const keptContext = (raw: TicketContext | undefined, s: HelpdeskSettings['context'], role: string) => {
  const c = raw ?? {};
  return {
    ...(s.page && c.page_url ? { page_url: c.page_url } : {}),
    ...(s.browser
      ? Object.fromEntries(
          (['user_agent', 'browser', 'os', 'screen', 'app_version'] as const).filter((k) => c[k]).map((k) => [k, c[k]]),
        )
      : {}),
    ...(s.errors && c.errors?.length ? { errors: c.errors.slice(-s.max_errors) } : {}),
    role,
  };
};

/** POST /support/tickets */
export const createTicket = async (deps: Deps, a: CustomerActor, raw: CreateTicket) => {
  assertCustomer(a);
  const input = createTicketSchema.parse(raw);
  const [settings, accountSettings] = await Promise.all([
    loadHelpdeskSettings(deps.db),
    loadAccountTicketSettings(deps.db, a.ctx.accountId),
  ]);
  if (!settings.enabled) throw new AppError('forbidden', 'tickets_disabled');
  if (!mayOpen(a, accountSettings.who_can_open, settings)) throw new AppError('forbidden', 'tickets_admins_only');
  const category = input.category_id ? await findCategory(deps.db, input.category_id) : undefined;
  if (input.category_id && (!category || category.archivedAt))
    throw new AppError('invalid_value', 'ticket_category_unknown');
  const files = input.attachment_ids.length ? await ownUploadedAssets(deps.db, a, input.attachment_ids) : [];
  const queueId = category?.queueId ?? (await defaultQueue(deps.db))?.id ?? null;
  const priority = (input.priority ?? category?.defaultPriority ?? settings.default_priority) as TicketPriority;
  const now = new Date();
  const due = slaDue(now, await findSla(deps.db, priority), settings.business_hours);
  const id = newId();
  const ticket = await deps.db.transaction(async (tx) => {
    const number = await nextTicketNumber(tx, settings.number_start);
    const row = await insertTicket(tx, {
      id,
      number,
      accountId: a.ctx.accountId,
      requesterId: a.user.id,
      requesterEmail: a.user.email,
      requesterName: a.user.name ?? '',
      subject: input.subject,
      status: 'new',
      priority,
      categoryId: category?.id ?? null,
      queueId,
      context: keptContext(input.context, settings.context, a.ctx.role),
      firstResponseDueAt: due.firstResponseDueAt,
      resolutionDueAt: due.resolutionDueAt,
      createdAt: now,
      updatedAt: now,
    });
    const messageId = await insertMessage(tx, {
      ticketId: id,
      authorId: a.user.id,
      authorName: a.user.name || a.user.email,
      kind: 'customer',
      visibility: 'public',
      body: input.description,
    });
    await insertAttachments(
      tx,
      id,
      messageId,
      files.map((f) => f.id),
    );
    await insertEvent(tx, id, a.user.id, 'created', { priority, category_id: category?.id ?? null, queue_id: queueId });
    return row;
  });
  const account = (await findAccountById(deps.db, a.ctx.accountId))!;
  await notifyCreated(deps, ticket, account);
  await notifyStaff(deps, ticket, account, 'new', `${ticket.subject}\n\n${input.description}`);
  return getTicket(deps, a, ticket.id);
};

/** A ticket this person may see in this account (else 404 — no existence leak). */
const loadOwnTicket = async (deps: Pick<Deps, 'db'>, a: CustomerActor, id: string) => {
  assertCustomer(a);
  const t = await findTicket(deps.db, id);
  if (!t || t.accountId !== a.ctx.accountId) throw new AppError('not_found', 'Ticket not found');
  const settings = await loadAccountTicketSettings(deps.db, a.ctx.accountId);
  if (!seesAll(a, settings.members_see) && t.requesterId !== a.user.id)
    throw new AppError('not_found', 'Ticket not found');
  return t;
};

/** GET /support/tickets — my tickets (admins and, by the setting, members: the account's), newest first. */
export const listMyTickets = async (
  deps: Pick<Deps, 'db'>,
  a: CustomerActor,
  q: { status?: string; cursor?: string; limit?: number },
) => {
  assertCustomer(a);
  const settings = await loadAccountTicketSettings(deps.db, a.ctx.accountId);
  const limit = q.limit ?? 50;
  const statuses =
    q.status === 'open'
      ? ['new', 'open', 'pending_customer', 'on_hold']
      : q.status === 'done'
        ? ['solved', 'closed']
        : undefined;
  const rows = await queryTickets(deps.db, {
    accountId: a.ctx.accountId,
    requesterId: seesAll(a, settings.members_see) ? undefined : a.user.id,
    statuses,
    before: q.cursor,
    limit,
  });
  const page = rows.slice(0, limit);
  return {
    data: await withTags(deps.db, page, false),
    next_cursor: rows.length > limit ? page[page.length - 1]!.t.id : null,
  };
};

/** GET /support/tickets/{id} — the public thread only (internal notes are never read on this side). */
export const getTicket = async (
  deps: Pick<Deps, 'db' | 'env'>,
  a: CustomerActor,
  id: string,
): Promise<TicketDetail> => {
  const t = await loadOwnTicket(deps, a, id);
  const [settings, category, messages, requests] = await Promise.all([
    loadHelpdeskSettings(deps.db),
    t.categoryId ? findCategory(deps.db, t.categoryId) : undefined,
    threadOf(deps, t, false),
    accessRequestsOf(deps.db, t.id),
  ]);
  const done = t.status === 'solved' || t.status === 'closed';
  const mine = t.requesterId === a.user.id || a.ctx.role === 'admin';
  return {
    ...summaryOf({ t, categoryName: category?.name ?? null }, false),
    messages,
    context: contextOf(t),
    access_requests: requests,
    csat_comment: t.csatComment,
    can: {
      reply: t.status !== 'closed',
      close: t.status !== 'closed',
      reopen: done,
      rate: settings.csat.enabled && done && mine,
      approve_access: a.ctx.role === 'admin',
    },
  };
};

const statusAfterCustomerReply = (s: string): TicketStatus =>
  s === 'pending_customer' || s === 'solved' ? 'open' : (s as TicketStatus);

/** POST /support/tickets/{id}/messages — the customer answers (a waiting or solved ticket opens again). */
export const replyAsCustomer = async (
  deps: Deps,
  a: CustomerActor,
  id: string,
  input: { body: string; attachment_ids?: string[] },
  meta: RequestMeta,
) => {
  const t = await loadOwnTicket(deps, a, id);
  if (t.status === 'closed') throw new AppError('conflict', 'ticket_closed');
  const files = input.attachment_ids?.length ? await ownUploadedAssets(deps.db, a, input.attachment_ids) : [];
  await deps.db.transaction(async (tx) => {
    const messageId = await insertMessage(tx, {
      ticketId: t.id,
      authorId: a.user.id,
      authorName: a.user.name || a.user.email,
      kind: 'customer',
      visibility: 'public',
      body: input.body,
    });
    await insertAttachments(
      tx,
      t.id,
      messageId,
      files.map((f) => f.id),
    );
    await updateTicketRow(tx, t.id, {});
    const next = statusAfterCustomerReply(t.status);
    if (next !== t.status) await changeStatus(tx, t, next, { id: a.user.id, side: 'customer' }, meta);
  });
  const account = (await findAccountById(deps.db, a.ctx.accountId))!;
  await notifyStaff(deps, (await findTicket(deps.db, t.id))!, account, 'customer_reply', input.body);
  return getTicket(deps, a, id);
};

/** POST /support/tickets/{id}/close — the customer closes (it is done); support access from it ends. */
export const closeTicket = async (deps: Deps, a: CustomerActor, id: string, meta: RequestMeta) => {
  const t = await loadOwnTicket(deps, a, id);
  await changeStatus(deps.db, t, 'closed', { id: a.user.id, side: 'customer' }, meta);
  return getTicket(deps, a, id);
};

/** POST /support/tickets/{id}/reopen — solved / closed → open again (a fresh resolution timer). */
export const reopenTicket = async (deps: Deps, a: CustomerActor, id: string, meta: RequestMeta) => {
  const t = await loadOwnTicket(deps, a, id);
  if (t.status !== 'solved' && t.status !== 'closed') throw new AppError('conflict', 'ticket_not_done');
  const settings = await loadHelpdeskSettings(deps.db);
  const due = slaDue(new Date(), await findSla(deps.db, t.priority), settings.business_hours);
  await deps.db.transaction(async (tx) => {
    const row = await changeStatus(tx, t, 'open', { id: a.user.id, side: 'customer' }, meta);
    await updateTicketRow(tx, row.id, { resolutionDueAt: due.resolutionDueAt, resolutionBreachAlertedAt: null });
    await insertEvent(tx, t.id, a.user.id, 'reopened');
  });
  return getTicket(deps, a, id);
};

/** POST /support/tickets/{id}/rating — satisfaction (1–5) once the ticket is solved or closed (when CSAT is on). */
export const rateTicket = async (
  deps: Pick<Deps, 'db' | 'env'>,
  a: CustomerActor,
  id: string,
  input: { rating: number; comment?: string },
) => {
  const t = await loadOwnTicket(deps, a, id);
  const settings = await loadHelpdeskSettings(deps.db);
  if (!settings.csat.enabled) throw new AppError('forbidden', 'csat_disabled');
  if (t.status !== 'solved' && t.status !== 'closed') throw new AppError('conflict', 'ticket_not_done');
  if (t.requesterId !== a.user.id && a.ctx.role !== 'admin') throw new AppError('forbidden', 'ticket_not_yours');
  await updateTicketRow(deps.db, t.id, {
    csatRating: input.rating,
    csatComment: input.comment?.trim() || null,
    csatAt: new Date(),
  });
  await insertEvent(deps.db, t.id, a.user.id, 'rated', { rating: input.rating });
  return getTicket(deps, a, id);
};

/** GET /support/tickets/{id}/attachments/{attachmentId} — a 15-minute download link (whoever sees the ticket). */
export const customerAttachment = async (deps: Deps, a: CustomerActor, id: string, attachmentId: string) => {
  const t = await loadOwnTicket(deps, a, id);
  return attachmentLink(deps, t, attachmentId, false);
};

export const attachmentLink = async (
  deps: Pick<Deps, 'db' | 'storage'>,
  t: TicketRow,
  attachmentId: string,
  staff: boolean,
) => {
  const f = await findAttachment(deps.db, t.id, attachmentId);
  if (!f || f.asset.uploadStatus !== 'uploaded' || !f.asset.storageKey || (!staff && f.visibility === 'internal'))
    throw new AppError('not_found', 'File not found');
  return {
    id: f.a.id,
    name: f.asset.fileName,
    size: f.asset.size,
    mime: f.asset.mime,
    download_url: await deps.storage.presignGet(
      f.asset.storageKey,
      f.asset.fileName,
      isInlineSafeMime(f.asset.mime) ? { inline: true } : undefined,
    ),
  };
};

// ---- access requests (account admins) ----

const loadRequestForAdmin = async (deps: Pick<Deps, 'db'>, a: CustomerActor, requestId: string) => {
  assertCustomer(a);
  if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
  const r = await findAccessRequest(deps.db, requestId);
  if (!r || r.accountId !== a.ctx.accountId) throw new AppError('not_found', 'Request not found');
  const t = await findTicket(deps.db, r.ticketId);
  if (!t) throw new AppError('not_found', 'Request not found');
  if (r.status !== 'pending') throw new AppError('conflict', 'access_request_decided');
  if (r.expiresAt <= new Date()) {
    await decideAccessRequest(deps.db, r.id, { status: 'expired', decidedBy: null });
    throw new AppError('conflict', 'access_request_expired');
  }
  return { r, t };
};

/**
 * POST /support/access-requests/{id}/approve — one click: a grant of the existing kind (`email` = the support
 * person who asked, the mode and duration they asked for), linked to the ticket; audited in the account.
 */
export const approveAccessRequest = async (deps: Deps, a: CustomerActor, requestId: string, meta: RequestMeta) => {
  const { r, t } = await loadRequestForAdmin(deps, a, requestId);
  if (t.status === 'solved' || t.status === 'closed') throw new AppError('conflict', 'ticket_closed');
  const staff = await findUser(deps.db, r.requestedBy);
  const stillStaff = staff && (staff.isPlatformOwner || (await findStaffRoleOf(deps.db, staff.id)));
  if (!staff || !stillStaff) throw new AppError('conflict', 'access_requester_inactive');
  const grant = await createSupportGrant(
    deps,
    { ctx: a.ctx, user: a.user, requestId: a.requestId },
    {
      grantee: 'email',
      email: staff.email.toLowerCase(),
      mode: r.mode === 'edit' ? 'edit' : 'view',
      duration_hours: r.durationHours,
      reason: `#${t.number} — ${r.reason}`.slice(0, 500),
    },
    meta,
    { ticketId: t.id, ticketNumber: t.number, accessRequestId: r.id },
  );
  await decideAccessRequest(deps.db, r.id, { status: 'approved', decidedBy: a.user.id, grantId: grant.id });
  await insertEvent(deps.db, t.id, a.user.id, 'access.approved', { request_id: r.id, grant_id: grant.id });
  await insertMessage(deps.db, {
    ticketId: t.id,
    authorId: a.user.id,
    authorName: a.user.name || a.user.email,
    kind: 'system',
    visibility: 'public',
    body: `access.approved:${r.mode}:${r.durationHours}`,
  });
  const account = (await findAccountById(deps.db, a.ctx.accountId))!;
  await notifyAccessDecision(deps, t, account, r, 'approved');
  return getTicket(deps, a, t.id);
};

/** POST /support/access-requests/{id}/decline */
export const declineAccessRequest = async (deps: Deps, a: CustomerActor, requestId: string) => {
  const { r, t } = await loadRequestForAdmin(deps, a, requestId);
  await decideAccessRequest(deps.db, r.id, { status: 'declined', decidedBy: a.user.id });
  await insertEvent(deps.db, t.id, a.user.id, 'access.declined', { request_id: r.id });
  await insertMessage(deps.db, {
    ticketId: t.id,
    authorId: a.user.id,
    authorName: a.user.name || a.user.email,
    kind: 'system',
    visibility: 'public',
    body: 'access.declined',
  });
  const account = (await findAccountById(deps.db, a.ctx.accountId))!;
  await notifyAccessDecision(deps, t, account, r, 'declined');
  return getTicket(deps, a, t.id);
};

/**
 * What a request may ask for in this account: the platform's and the account's grant options (the same rules an
 * admin's own grant form follows), so the one-click approval never fails on them.
 */
export const accessOptionsFor = async (deps: Pick<Deps, 'db'>, accountId: string) => {
  const [platform, settings] = await Promise.all([
    loadPlatformSettings(deps.db),
    getAccountSettings(deps.db, accountId),
  ]);
  return grantOptions(platform.support, securityOf(settings).support_access);
};

// ---- account settings (admins) ----

export const getAccountTicketSettings = async (deps: Pick<Deps, 'db'>, a: CustomerActor) => {
  assertCustomer(a);
  if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
  return loadAccountTicketSettings(deps.db, a.ctx.accountId);
};

export const updateAccountTicketSettings = async (
  deps: Pick<Deps, 'db'>,
  a: CustomerActor,
  patch: { who_can_open?: 'admins' | 'members'; members_see?: 'own' | 'all' },
) => {
  assertCustomer(a);
  if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
  return saveAccountTicketSettings(deps.db, a.ctx.accountId, a.user.id, patch);
};
