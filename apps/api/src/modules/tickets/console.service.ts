// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type SupportConsoleConfig,
  type SupportConsoleRole,
  type SupportReport,
  type SupportStaff,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketDetail,
  type TicketPriority,
  type TicketStatus,
  type UpdateHelpdeskSettings,
} from '@bines/shared';
import { z } from 'zod';
import type { AppDeps, RequestMeta, SessionUser } from '../../types';
import { findAccountById } from '../accounts/accounts.repo';
import { changeStatus } from './tickets.lifecycle';
import { accessRequestsOf, contextOf, summaryOf, threadOf, withTags } from './tickets.dto';
import { notifyAccessRequest, notifyReply, notifyStaffInvited, notifyStatus } from './tickets.notify';
import { slaDue } from './tickets.sla';
import { loadHelpdeskSettings, saveHelpdeskSettings } from './tickets.settings';
import { accessOptionsFor, attachmentLink } from './tickets.service';
import { attachableArticles, searchAttachableArticles } from './tickets.articles';
import {
  clearDefaultQueue,
  deleteTagRow,
  findCanned,
  findCategory,
  findQueue,
  findSla,
  findStaffByEmail,
  findStaffById,
  findTag,
  findTagByName,
  findTicket,
  findTicketListRow,
  findAccessRequest,
  decideAccessRequest,
  insertAccessRequest,
  insertCanned,
  insertCategory,
  insertEvent,
  insertMessage,
  insertQueue,
  insertStaff,
  insertTag,
  listAgents,
  listCanned,
  listCategories,
  listEvents,
  listQueues,
  listSla,
  listStaff,
  listTags,
  queryTickets,
  recordAssignment,
  reportByCategory,
  reportCounts,
  reportDurations,
  reportSolvedSince,
  setTicketTags,
  ticketTagsOf,
  type TicketRow,
  updateCannedRow,
  updateCategoryRow,
  updateQueueRow,
  updateStaffRow,
  updateTagRow,
  updateTicketRow,
  upsertSla,
} from './tickets.repo';
/**
 * Support tickets — the staff side, the owner console's "Support" section. Who may: the platform
 * owner (everything) and active support staff — an agent works tickets; a lead also manages queues, categories, SLA,
 * canned replies, tags and the settings; only the owner manages the staff. A ticket shows what the customer wrote
 * and attached, never the account's data: for that the agent asks for access from the ticket.
 */
type Deps = Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger' | 'storage' | 'auth'>;
export type StaffActor = { user: SessionUser; role: SupportConsoleRole };

const assertLead = (s: StaffActor) => {
  if (s.role === 'agent') throw new AppError('forbidden', 'support_lead_only');
};
const assertOwner = (s: StaffActor) => {
  if (s.role !== 'owner') throw new AppError('forbidden', 'platform_owner_only');
};

const mustTicket = async (deps: Pick<Deps, 'db'>, id: string) => {
  const t = await findTicket(deps.db, id);
  if (!t) throw new AppError('not_found', 'Ticket not found');
  return t;
};

const listParam = <T extends string>(raw: string | undefined, allowed: readonly T[]) =>
  raw
    ?.split(',')
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));

/** GET /platform/support/tickets — the queue with its filters (newest first). */
export const listConsoleTickets = async (
  deps: Pick<Deps, 'db'>,
  s: StaffActor,
  f: {
    status?: string;
    priority?: string;
    category_id?: string;
    queue_id?: string;
    assignee?: string;
    tag_id?: string;
    account_id?: string;
    breached?: 'any' | 'first_response' | 'resolution';
    q?: string;
    cursor?: string;
    limit?: number;
  },
) => {
  const limit = f.limit ?? 50;
  const statuses =
    f.status === 'active' ? ['new', 'open', 'pending_customer', 'on_hold'] : listParam(f.status, TICKET_STATUSES);
  const rows = await queryTickets(deps.db, {
    accountId: f.account_id,
    statuses,
    priorities: listParam(f.priority, TICKET_PRIORITIES),
    categoryId: f.category_id,
    queueId: f.queue_id,
    assignee:
      f.assignee === 'none'
        ? { kind: 'none' }
        : f.assignee === 'me'
          ? { kind: 'user', id: s.user.id }
          : f.assignee
            ? { kind: 'user', id: f.assignee }
            : undefined,
    tagId: f.tag_id,
    breached: f.breached,
    q: f.q,
    before: f.cursor,
    limit,
  });
  const page = rows.slice(0, limit);
  return {
    data: await withTags(deps.db, page, true),
    next_cursor: rows.length > limit ? page[page.length - 1]!.t.id : null,
  };
};

/** GET /platform/support/tickets/{id} — the full thread (internal notes too), the history, the access requests. */
export const getConsoleTicket = async (deps: Pick<Deps, 'db' | 'env'>, _s: StaffActor, id: string) => {
  const t = await mustTicket(deps, id);
  const row = (await findTicketListRow(deps.db, t.id))!;
  const [tags, messages, requests, events, options] = await Promise.all([
    ticketTagsOf(deps.db, [t.id]),
    threadOf(deps, t, true),
    accessRequestsOf(deps.db, t.id),
    listEvents(deps.db, t.id),
    accessOptionsFor(deps, t.accountId),
  ]);
  const settings = await loadHelpdeskSettings(deps.db);
  const detail: TicketDetail = {
    ...summaryOf(
      row,
      true,
      tags.map(({ id: tagId, name, color }) => ({ id: tagId, name, color })),
    ),
    messages,
    context: contextOf(t),
    access_requests: requests,
    csat_comment: t.csatComment,
    can: { reply: true, close: t.status !== 'closed', reopen: false, rate: false, approve_access: false },
    events: events.map(({ e, actorName }) => ({
      id: e.id,
      type: e.type,
      actor: e.actorId ? { id: e.actorId, name: actorName ?? '' } : null,
      data: e.data,
      created_at: e.createdAt.toISOString(),
    })),
    // What an access request may ask for in this account (the grant form's own rules).
    access_options: {
      durations_hours: options.durations_hours,
      allow_edit: options.allow_edit,
      default_mode:
        settings.access.default_mode === 'edit' && options.allow_edit ? ('edit' as const) : ('view' as const),
      default_duration_hours: options.durations_hours.includes(settings.access.default_duration_hours)
        ? settings.access.default_duration_hours
        : options.default_duration_hours,
    },
  };
  return detail;
};

/** PATCH /platform/support/tickets/{id} — status, priority, category, queue, assignee, tags. */
export const updateConsoleTicket = async (
  deps: Deps,
  s: StaffActor,
  id: string,
  patch: {
    status?: TicketStatus;
    priority?: TicketPriority;
    category_id?: string | null;
    queue_id?: string | null;
    assignee_id?: string | null;
    tag_ids?: string[];
  },
  meta: RequestMeta,
) => {
  let t = await mustTicket(deps, id);
  const before = t.status;
  await deps.db.transaction(async (tx) => {
    const fields: Partial<TicketRow> = {};
    if (patch.priority && patch.priority !== t.priority) {
      // A new priority means its SLA targets, counted from the ticket's start.
      const settings = await loadHelpdeskSettings(tx);
      const due = slaDue(t.createdAt, await findSla(tx, patch.priority), settings.business_hours);
      fields.priority = patch.priority;
      if (!t.firstRespondedAt) fields.firstResponseDueAt = due.firstResponseDueAt;
      if (!t.solvedAt) fields.resolutionDueAt = due.resolutionDueAt;
      await insertEvent(tx, t.id, s.user.id, 'priority', { from: t.priority, to: patch.priority });
    }
    if (patch.category_id !== undefined && patch.category_id !== t.categoryId) {
      if (patch.category_id && !(await findCategory(tx, patch.category_id)))
        throw new AppError('invalid_value', 'ticket_category_unknown');
      fields.categoryId = patch.category_id;
      await insertEvent(tx, t.id, s.user.id, 'category', { from: t.categoryId, to: patch.category_id });
    }
    if (patch.queue_id !== undefined && patch.queue_id !== t.queueId) {
      if (patch.queue_id && !(await findQueue(tx, patch.queue_id)))
        throw new AppError('invalid_value', 'ticket_queue_unknown');
      fields.queueId = patch.queue_id;
      await insertEvent(tx, t.id, s.user.id, 'queue', { from: t.queueId, to: patch.queue_id });
    }
    if (patch.assignee_id !== undefined && patch.assignee_id !== t.assigneeId) {
      if (patch.assignee_id && !(await listAgents(tx)).some((x) => x.id === patch.assignee_id))
        throw new AppError('invalid_value', 'ticket_assignee_not_staff');
      fields.assigneeId = patch.assignee_id;
      await recordAssignment(tx, t.id, patch.assignee_id, s.user.id);
      await insertEvent(tx, t.id, s.user.id, patch.assignee_id ? 'assigned' : 'unassigned', {
        from: t.assigneeId,
        to: patch.assignee_id,
      });
    }
    if (patch.tag_ids) {
      const ids = [...new Set(patch.tag_ids)];
      for (const tagId of ids)
        if (!(await findTag(tx, tagId))) throw new AppError('invalid_value', 'ticket_tag_unknown');
      await setTicketTags(tx, t.id, ids);
      await insertEvent(tx, t.id, s.user.id, 'tags', { tag_ids: ids });
    }
    if (Object.keys(fields).length) await updateTicketRow(tx, t.id, fields);
    t = (await findTicket(tx, t.id))!;
    if (patch.status && patch.status !== t.status)
      t = await changeStatus(tx, t, patch.status, { id: s.user.id, side: 'staff' }, meta);
  });
  if (t.status !== before) {
    const account = await findAccountById(deps.db, t.accountId);
    if (account) await notifyStatus(deps, t, account, s.user.id);
  }
  return getConsoleTicket(deps, s, id);
};

/**
 * POST /platform/support/tickets/{id}/messages — a public reply (the customer is emailed and notified; the first
 * one stops the first-response timer) or an internal note (staff only).
 */
export const replyAsStaff = async (
  deps: Deps,
  s: StaffActor,
  id: string,
  input: { body?: string; visibility: 'public' | 'internal'; status?: TicketStatus; article_ids?: string[] },
  meta: RequestMeta,
) => {
  let t = await mustTicket(deps, id);
  if (t.status === 'closed' && input.visibility === 'public') throw new AppError('conflict', 'ticket_closed');
  const body = input.body?.trim() ?? '';
  // Attached articles: only ones the ticket's customer may read; the reply keeps their ids.
  const articles = await attachableArticles(deps, input.article_ids ?? []);
  if (!body && !articles.length) throw new AppError('invalid_value', 'ticket_reply_empty');
  const before = t.status;
  const name = s.user.name || s.user.email;
  await deps.db.transaction(async (tx) => {
    const messageId = await insertMessage(tx, {
      ticketId: t.id,
      authorId: s.user.id,
      authorName: name,
      kind: 'staff',
      visibility: input.visibility,
      body,
      articleIds: articles.map((a) => a.id),
    });
    if (articles.length)
      await insertEvent(tx, t.id, s.user.id, 'articles', {
        message_id: messageId,
        article_ids: articles.map((a) => a.id),
      });
    if (input.visibility === 'public') {
      await updateTicketRow(tx, t.id, t.firstRespondedAt ? {} : { firstRespondedAt: new Date() });
      if (!t.assigneeId) {
        await updateTicketRow(tx, t.id, { assigneeId: s.user.id });
        await recordAssignment(tx, t.id, s.user.id, s.user.id);
        await insertEvent(tx, t.id, s.user.id, 'assigned', { from: null, to: s.user.id, auto: true });
      }
    } else await insertEvent(tx, t.id, s.user.id, 'note');
    t = (await findTicket(tx, t.id))!;
    const next = input.status ?? (input.visibility === 'public' && t.status === 'new' ? 'open' : undefined);
    if (next && next !== t.status) t = await changeStatus(tx, t, next, { id: s.user.id, side: 'staff' }, meta);
  });
  if (input.visibility === 'public') {
    const account = await findAccountById(deps.db, t.accountId);
    if (account) {
      await notifyReply(deps, t, account, { body, authorId: s.user.id, authorName: name, articles });
      // A reply that also changes the status to something the customer must know about tells them once more.
      if (t.status !== before && (t.status === 'solved' || t.status === 'closed'))
        await notifyStatus(deps, t, account, s.user.id);
    }
  }
  return getConsoleTicket(deps, s, id);
};

/**
 * GET /platform/support/tickets/{id}/articles — the "attach an article" picker: published articles the ticket's
 * customer may read.
 */
export const ticketArticleChoices = async (
  deps: Pick<Deps, 'db' | 'env'>,
  _s: StaffActor,
  id: string,
  f: { q?: string; limit?: number },
) => {
  await mustTicket(deps, id);
  return searchAttachableArticles(deps, f);
};

/** GET /platform/support/tickets/{id}/attachments/{attachmentId} */
export const consoleAttachment = async (deps: Deps, _s: StaffActor, id: string, attachmentId: string) =>
  attachmentLink(deps, await mustTicket(deps, id), attachmentId, true);

/**
 * POST /platform/support/tickets/{id}/access-requests — ask the account's admins to let me in (view by default,
 * for the default hours, with a reason). The options are the account's grant rules, so approving never fails on them.
 */
export const requestAccess = async (
  deps: Deps,
  s: StaffActor,
  id: string,
  input: { mode?: 'view' | 'edit'; duration_hours?: number; reason: string },
) => {
  const t = await mustTicket(deps, id);
  if (t.status === 'solved' || t.status === 'closed') throw new AppError('conflict', 'ticket_closed');
  if (!s.user.emailVerified) throw new AppError('conflict', 'email_not_verified');
  const settings = await loadHelpdeskSettings(deps.db);
  const options = await accessOptionsFor(deps, t.accountId);
  const mode = input.mode ?? settings.access.default_mode;
  if (mode === 'edit' && !options.allow_edit) throw new AppError('forbidden', 'support_edit_not_allowed');
  const wanted = input.duration_hours ?? settings.access.default_duration_hours;
  const hours = options.durations_hours.includes(wanted)
    ? wanted
    : input.duration_hours === undefined
      ? options.default_duration_hours
      : null;
  if (hours === null)
    throw new AppError('invalid_value', 'support_duration_not_allowed', { allowed: options.durations_hours });
  const r = await insertAccessRequest(deps.db, {
    ticketId: t.id,
    accountId: t.accountId,
    requestedBy: s.user.id,
    mode,
    durationHours: hours,
    reason: input.reason,
    expiresAt: new Date(Date.now() + settings.access.request_expires_hours * 3_600_000),
  });
  await insertEvent(deps.db, t.id, s.user.id, 'access.requested', { request_id: r.id, mode, duration_hours: hours });
  const account = await findAccountById(deps.db, t.accountId);
  if (account) await notifyAccessRequest(deps, t, account, r, { id: s.user.id, name: s.user.name || s.user.email });
  return getConsoleTicket(deps, s, id);
};

/** POST /platform/support/access-requests/{id}/cancel — the agent withdraws a pending request. */
export const cancelAccessRequest = async (deps: Pick<Deps, 'db' | 'env'>, s: StaffActor, requestId: string) => {
  const r = await findAccessRequest(deps.db, requestId);
  if (!r) throw new AppError('not_found', 'Request not found');
  if (r.requestedBy !== s.user.id && s.role === 'agent') throw new AppError('forbidden', 'not_your_request');
  if (!(await decideAccessRequest(deps.db, r.id, { status: 'cancelled', decidedBy: s.user.id })))
    throw new AppError('conflict', 'access_request_decided');
  await insertEvent(deps.db, r.ticketId, s.user.id, 'access.cancelled', { request_id: r.id });
  return getConsoleTicket(deps, s, r.ticketId);
};

// ---------------------------------------------------------------------------
// Configuration (leads and the owner) and staff (the owner)
// ---------------------------------------------------------------------------
export const consoleConfig = async (deps: Pick<Deps, 'db'>, s: StaffActor): Promise<SupportConsoleConfig> => {
  const [settings, queues, categories, sla, canned, tags, agents] = await Promise.all([
    loadHelpdeskSettings(deps.db),
    listQueues(deps.db),
    listCategories(deps.db),
    listSla(deps.db),
    listCanned(deps.db),
    listTags(deps.db),
    listAgents(deps.db),
  ]);
  return {
    role: s.role,
    me: { id: s.user.id, name: s.user.name || s.user.email },
    settings,
    queues: queues.map((q) => ({
      id: q.id,
      name: q.name,
      description: q.description,
      is_default: q.isDefault,
      position: q.position,
      archived: !!q.archivedAt,
    })),
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      queue_id: c.queueId,
      default_priority: (c.defaultPriority as TicketPriority | null) ?? null,
      position: c.position,
      archived: !!c.archivedAt,
    })),
    sla: TICKET_PRIORITIES.flatMap((p) => {
      const row = sla.find((x) => x.priority === p);
      return row
        ? [
            {
              priority: p,
              first_response_minutes: row.firstResponseMinutes,
              resolution_minutes: row.resolutionMinutes,
              business_hours: row.businessHours,
            },
          ]
        : [];
    }),
    canned: canned.map((c) => ({
      id: c.id,
      title: c.title,
      body: c.body,
      queue_id: c.queueId,
      archived: !!c.archivedAt,
    })),
    tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
  };
};

export const updateSettings = async (deps: Pick<Deps, 'db'>, s: StaffActor, patch: UpdateHelpdeskSettings) => {
  assertLead(s);
  await saveHelpdeskSettings(deps.db, s.user.id, patch);
  return consoleConfig(deps, s);
};

type QueueInput = {
  name: string;
  description?: string | null;
  is_default?: boolean;
  position?: number;
  archived?: boolean;
};
export const saveQueue = async (deps: Pick<Deps, 'db'>, s: StaffActor, id: string | null, input: QueueInput) => {
  assertLead(s);
  await deps.db.transaction(async (tx) => {
    if (input.is_default) await clearDefaultQueue(tx);
    const row = {
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.is_default !== undefined ? { isDefault: input.is_default } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
    };
    if (id) {
      if (!(await findQueue(tx, id))) throw new AppError('not_found', 'Queue not found');
      await updateQueueRow(tx, id, row);
    } else await insertQueue(tx, row);
  });
  return consoleConfig(deps, s);
};

type CategoryInput = {
  name: string;
  queue_id?: string | null;
  default_priority?: TicketPriority | null;
  position?: number;
  archived?: boolean;
};
export const saveCategory = async (deps: Pick<Deps, 'db'>, s: StaffActor, id: string | null, input: CategoryInput) => {
  assertLead(s);
  if (input.queue_id && !(await findQueue(deps.db, input.queue_id)))
    throw new AppError('invalid_value', 'ticket_queue_unknown');
  const row = {
    name: input.name,
    ...(input.queue_id !== undefined ? { queueId: input.queue_id } : {}),
    ...(input.default_priority !== undefined ? { defaultPriority: input.default_priority } : {}),
    ...(input.position !== undefined ? { position: input.position } : {}),
    ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
  };
  if (id) {
    if (!(await findCategory(deps.db, id))) throw new AppError('not_found', 'Category not found');
    await updateCategoryRow(deps.db, id, row);
  } else await insertCategory(deps.db, row);
  return consoleConfig(deps, s);
};

export const putSla = async (
  deps: Pick<Deps, 'db'>,
  s: StaffActor,
  policies: {
    priority: TicketPriority;
    first_response_minutes: number;
    resolution_minutes: number;
    business_hours: boolean;
  }[],
) => {
  assertLead(s);
  for (const p of policies) {
    if (p.resolution_minutes < p.first_response_minutes)
      throw new AppError('invalid_value', 'sla_resolution_before_first_response');
    await upsertSla(deps.db, {
      priority: p.priority,
      firstResponseMinutes: p.first_response_minutes,
      resolutionMinutes: p.resolution_minutes,
      businessHours: p.business_hours,
    });
  }
  return consoleConfig(deps, s);
};

type CannedInput = { title: string; body: string; queue_id?: string | null; archived?: boolean };
export const saveCanned = async (deps: Pick<Deps, 'db'>, s: StaffActor, id: string | null, input: CannedInput) => {
  assertLead(s);
  const row = {
    title: input.title,
    body: input.body,
    ...(input.queue_id !== undefined ? { queueId: input.queue_id } : {}),
    ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
  };
  if (id) {
    if (!(await findCanned(deps.db, id))) throw new AppError('not_found', 'Reply not found');
    await updateCannedRow(deps.db, id, row);
  } else await insertCanned(deps.db, { ...row, createdBy: s.user.id });
  return consoleConfig(deps, s);
};

export const saveTag = async (
  deps: Pick<Deps, 'db'>,
  s: StaffActor,
  id: string | null,
  input: { name: string; color?: string | null },
) => {
  assertLead(s);
  const same = await findTagByName(deps.db, input.name);
  if (same && same.id !== id) throw new AppError('conflict', 'support_tag_exists');
  if (id) {
    if (!(await findTag(deps.db, id))) throw new AppError('not_found', 'Tag not found');
    await updateTagRow(deps.db, id, { name: input.name, ...(input.color !== undefined ? { color: input.color } : {}) });
  } else await insertTag(deps.db, { name: input.name, color: input.color ?? null });
  return consoleConfig(deps, s);
};

export const deleteTag = async (deps: Pick<Deps, 'db'>, s: StaffActor, id: string) => {
  assertLead(s);
  if (!(await findTag(deps.db, id))) throw new AppError('not_found', 'Tag not found');
  await deleteTagRow(deps.db, id);
  return consoleConfig(deps, s);
};

// ---- staff (the platform owner) ----

const staffDto = (r: Awaited<ReturnType<typeof listStaff>>[number]): SupportStaff => ({
  id: r.staff.id,
  email: r.staff.email,
  name: r.name ?? null,
  user_id: r.linkedId ?? null,
  role: r.staff.role === 'lead' ? 'lead' : 'agent',
  status: r.staff.status === 'deactivated' ? 'deactivated' : 'active',
  created_at: r.staff.createdAt.toISOString(),
});

export const listSupportStaff = async (deps: Pick<Deps, 'db'>, s: StaffActor) => {
  assertOwner(s);
  return { data: (await listStaff(deps.db)).map(staffDto) };
};

/** POST /platform/support/staff — invite by email (they sign in with that address; nothing else of the console). */
export const inviteSupportStaff = async (
  deps: Deps,
  s: StaffActor,
  input: { email: string; role: 'agent' | 'lead' },
) => {
  assertOwner(s);
  const email = z.email().parse(input.email.trim().toLowerCase());
  const existing = await findStaffByEmail(deps.db, email);
  if (existing) await updateStaffRow(deps.db, existing.id, { role: input.role, status: 'active' });
  else await insertStaff(deps.db, { email, role: input.role, status: 'active', invitedBy: s.user.id });
  await notifyStaffInvited(deps, email, input.role, s.user.locale);
  return listSupportStaff(deps, s);
};

export const updateSupportStaff = async (
  deps: Pick<Deps, 'db'>,
  s: StaffActor,
  id: string,
  patch: { role?: 'agent' | 'lead'; status?: 'active' | 'deactivated' },
) => {
  assertOwner(s);
  if (!(await findStaffById(deps.db, id))) throw new AppError('not_found', 'Staff not found');
  await updateStaffRow(deps.db, id, patch);
  return listSupportStaff(deps, s);
};

// ---- reports ----

const minutes = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
const stat = (list: number[]) => {
  if (!list.length) return { count: 0, avg_minutes: null, median_minutes: null };
  const sorted = [...list].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return {
    count: list.length,
    avg_minutes: Math.round(list.reduce((x, y) => x + y, 0) / list.length),
    median_minutes: sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2),
  };
};

/** GET /platform/support/reports?days= — volume, first response, resolution, CSAT, per day / agent / category. */
export const supportReport = async (deps: Pick<Deps, 'db'>, _s: StaffActor, days: number): Promise<SupportReport> => {
  const since = new Date(Date.now() - days * 86_400_000);
  const [counts, durations, byCategory, solved, agents] = await Promise.all([
    reportCounts(deps.db, since),
    reportDurations(deps.db, since),
    reportByCategory(deps.db, since),
    reportSolvedSince(deps.db, since),
    listAgents(deps.db),
  ]);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const byDay = new Map<string, { created: number; solved: number }>();
  for (let i = days - 1; i >= 0; i--) byDay.set(day(new Date(Date.now() - i * 86_400_000)), { created: 0, solved: 0 });
  for (const d of durations) {
    const e = byDay.get(day(d.createdAt));
    if (e) e.created++;
  }
  for (const d of solved) {
    const e = d.solvedAt ? byDay.get(day(d.solvedAt)) : undefined;
    if (e) e.solved++;
  }
  const first = durations.flatMap((d) => (d.firstRespondedAt ? [minutes(d.createdAt, d.firstRespondedAt)] : []));
  const resolution = durations.flatMap((d) => (d.solvedAt ? [minutes(d.createdAt, d.solvedAt)] : []));
  return {
    days,
    created: counts.created,
    solved: counts.solved,
    open_now: counts.openNow,
    breached_now: counts.breachedNow,
    first_response: stat(first),
    resolution: stat(resolution),
    csat: {
      count: counts.csatCount,
      avg: counts.csatAvg === null ? null : Math.round(counts.csatAvg * 100) / 100,
      satisfied_share: counts.csatCount ? Math.round((counts.csatSatisfied / counts.csatCount) * 100) / 100 : null,
    },
    by_day: [...byDay.entries()].map(([date, v]) => ({ date, ...v })),
    by_agent: agents
      .map((a) => {
        const mine = durations.filter((d) => d.assigneeId === a.id);
        const fr = stat(mine.flatMap((d) => (d.firstRespondedAt ? [minutes(d.createdAt, d.firstRespondedAt)] : [])));
        return {
          id: a.id,
          name: a.name,
          assigned: mine.length,
          solved: solved.filter((d) => d.assigneeId === a.id).length,
          avg_first_response_minutes: fr.avg_minutes,
        };
      })
      .filter((a) => a.assigned || a.solved),
    by_category: byCategory.map((c) => ({ id: c.id, name: c.name, count: Number(c.count) })),
  };
};
