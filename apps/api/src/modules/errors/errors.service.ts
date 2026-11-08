// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AccountHealth,
  AppError,
  type ErrorAlert,
  type ErrorDetail,
  type ErrorEvent,
  type ErrorFilter,
  type ErrorHubConfig,
  ERROR_SEVERITIES,
  ERROR_SOURCES,
  ERROR_STATUSES,
  type ErrorStatus,
  type SupportConsoleRole,
  type UpdateErrorHubSettings,
  glitchtipUrl,
  newId,
  OPEN_ERROR_STATUSES,
  redactErrorMessage,
} from '@bines/shared';
import { RateLimiter } from '../../lib/rate-limit';
import { st } from '../../lib/i18n';
import type { AccountContext, AppDeps, SessionUser } from '../../types';
import { findAccountBySlug } from '../accounts/accounts.repo';
import { webOrigin } from '../platform/public-address';
import { resolveAccountAccess } from '../support/support.access';
import { loadHelpdeskSettings } from '../tickets/tickets.settings';
import { slaDue } from '../tickets/tickets.sla';
import {
  defaultQueue,
  findSla,
  insertEvent,
  insertMessage,
  insertTicket,
  listAgents,
  nextTicketNumber,
} from '../tickets/tickets.repo';
import { consoleTicketUrl } from '../tickets/tickets.notify';
import {
  accountErrors,
  accountList,
  accountOccurrencesSince,
  agentRunTrace,
  alertsFor,
  automationRunLog,
  errorsByAccount,
  type ErrorEventRow,
  type ErrorListRow,
  eventsByIds,
  findErrorEvent,
  findErrorRow,
  findTicketByNumber,
  hourlyOf,
  markAlertsRead,
  queryErrors,
  unreadAlertCount,
  updateErrorRow,
} from './errors.repo';
import { loadErrorHubSettings, saveErrorHubSettings } from './errors.settings';
import { droppedErrors, recordError } from './errors.writer';

/**
 * The errors hub's service. The console side (`/platform/errors/*`) is for the platform owner and
 * the support staff (`requireSupportConsole`): metadata of every account's errors, never the account's data — the
 * trace and the "open in the account" link need an active support grant (or a membership), exactly like entering
 * the account. The account side is its Health page (admins), without support's fields.
 */
type Deps = Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>;
export type HubActor = { user: SessionUser; role: SupportConsoleRole };

const HOUR = 3_600_000;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const list = <T extends string>(raw: string | undefined, allowed: readonly T[]) =>
  raw
    ?.split(',')
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));

export const errorDto = (r: ErrorListRow): ErrorEvent => ({
  id: r.e.id,
  account: r.e.accountId ? { id: r.e.accountId, name: r.accountName ?? '', slug: r.accountSlug ?? '' } : null,
  source: r.e.source as ErrorEvent['source'],
  code: r.e.code,
  severity: r.e.severity as ErrorEvent['severity'],
  message: r.e.message,
  links: r.e.links ?? {},
  count: r.e.count,
  first_seen_at: r.e.firstSeenAt.toISOString(),
  last_seen_at: r.e.lastSeenAt.toISOString(),
  status: r.e.status as ErrorStatus,
  assignee: r.e.assigneeId ? { id: r.e.assigneeId, name: r.assigneeName || r.assigneeEmail || '' } : null,
  muted_until: iso(r.e.mutedUntil),
  resolved_at: iso(r.e.resolvedAt),
  reopened_count: r.e.reopenedCount,
  ticket: r.e.ticketId && r.ticketNumber ? { id: r.e.ticketId, number: r.ticketNumber } : null,
  note: r.e.note,
  last_hour: Number(r.lastHour) || 0,
});

/** GET /platform/errors */
export const listErrors = async (deps: Pick<Deps, 'db'>, s: HubActor, f: ErrorFilter, now = new Date()) => {
  const settings = await loadErrorHubSettings(deps.db);
  const view = f.view ?? 'all';
  const { rows, total } = await queryErrors(deps.db, {
    view,
    sources: list(f.source, ERROR_SOURCES),
    severities: list(f.severity, ERROR_SEVERITIES),
    statuses: list(f.status, ERROR_STATUSES) ?? (view === 'all' ? undefined : [...OPEN_ERROR_STATUSES]),
    accountId: f.account_id ?? null,
    assignee: f.assignee === 'me' ? s.user.id : f.assignee,
    q: f.q,
    spike: { factor: settings.spike.factor, minCount: settings.spike.min_count },
    limit: f.limit ?? 50,
    offset: f.offset ?? 0,
    now,
  });
  return { data: rows.map(errorDto), total };
};

/** GET /platform/errors/accounts — the "by account" view. */
export const listErrorAccounts = async (deps: Pick<Deps, 'db'>, now = new Date()) => ({
  data: (await errorsByAccount(deps.db, now)).map((r) => ({
    account: r.accountId ? { id: r.accountId, name: r.accountName ?? '', slug: r.accountSlug ?? '' } : null,
    open: Number(r.open) || 0,
    critical: Number(r.critical) || 0,
    occurrences_24h: Number(r.day) || 0,
    last_seen_at: r.lastSeen ? new Date(r.lastSeen).toISOString() : null,
  })),
});

const mustError = async (deps: Pick<Deps, 'db'>, id: string, now = new Date()) => {
  const row = await findErrorRow(deps.db, id, now);
  if (!row) throw new AppError('not_found', 'Error not found');
  return row;
};

/** Where an error opens inside its account (by its most specific link). */
export const openPathOf = (slug: string, links: Record<string, string>) => {
  const base = `/a/${slug}`;
  if (links.item_id) return `${base}/i/${links.item_id}`;
  if (links.agent_id) return `${base}/agents/${links.agent_id}`;
  if (links.flow_connection_id)
    return `${base}/flows?connection=${links.flow_connection_id}${links.flow_id ? `&flow=${encodeURIComponent(links.flow_id)}` : ''}`;
  if (links.board_id) return `${base}/b/${links.board_id}`;
  if (links.installation_id) return `${base}/admin/extensions`;
  if (links.ai_connection_id) return `${base}/admin/ai`;
  if (links.automation_id) return `${base}/automations`;
  return base;
};

/** The steps of the run behind an error: types, statuses and codes — never inputs, outputs or values. */
const traceOf = async (deps: Pick<Deps, 'db'>, e: ErrorEventRow): Promise<ErrorDetail['trace']> => {
  const links = e.links ?? {};
  if (e.accountId && links.run_id && e.source === 'automation') {
    const run = await automationRunLog(deps.db, e.accountId, links.run_id);
    if (!run) return null;
    return ((run.log ?? []) as Record<string, unknown>[]).map((l, i) => ({
      index: typeof l.index === 'number' ? l.index : i,
      type: String(l.type ?? ''),
      status: String(l.status ?? ''),
      code: typeof l.code === 'string' ? l.code : null,
      reason: typeof l.reason === 'string' ? l.reason : null,
      duration_ms: typeof l.duration_ms === 'number' ? l.duration_ms : null,
    }));
  }
  if (links.agent_run_id) {
    const steps = await agentRunTrace(deps.db, links.agent_run_id);
    return steps.map((st) => ({
      index: st.index,
      type: st.tool ? `${st.kind}:${st.tool}` : st.kind,
      status: st.outcome ?? (st.isError ? 'error' : 'ok'),
      code: null,
      reason: null,
      duration_ms: null,
    }));
  }
  return null;
};

/** GET /platform/errors/{id} — the error, its last 24 hours, and (with access to the account) the run trace. */
export const getErrorDetail = async (deps: Pick<Deps, 'db'>, s: HubActor, id: string, now = new Date()) => {
  const row = await mustError(deps, id, now);
  const settings = await loadErrorHubSettings(deps.db);
  const since = new Date(Math.floor(now.getTime() / HOUR) * HOUR - 23 * HOUR);
  const hourly = (await hourlyOf(deps.db, id, since)).map((h) => ({ hour: h.hour.toISOString(), count: h.count }));
  let access: ErrorDetail['access'] = { granted: false, mode: null };
  if (row.e.accountId) {
    const a = await resolveAccountAccess(deps.db, row.e.accountId, s.user.id);
    if (a?.kind === 'member') access = { granted: true, mode: 'member' };
    else if (a?.kind === 'support') access = { granted: true, mode: a.support.mode };
  }
  const detail: ErrorDetail = {
    event: errorDto(row),
    hourly,
    access,
    trace: access.granted ? await traceOf(deps, row.e) : null,
    open_path: access.granted && row.accountSlug ? openPathOf(row.accountSlug, row.e.links ?? {}) : null,
    glitchtip_url: row.e.source === 'code' ? glitchtipUrl(settings.glitchtip, row.e.links?.request_id) : null,
  };
  return detail;
};

/** PATCH /platform/errors/{id} — status (acknowledge / resolve / ignore / reopen), assignee, mute, note. */
export const updateError = async (
  deps: Pick<Deps, 'db'>,
  s: HubActor,
  id: string,
  patch: { status?: ErrorStatus; assignee_id?: string | null; muted_until?: string | null; note?: string | null },
) => {
  const row = await mustError(deps, id);
  const set: Parameters<typeof updateErrorRow>[2] = {};
  if (patch.status && patch.status !== row.e.status) {
    set.status = patch.status;
    if (patch.status === 'resolved') Object.assign(set, { resolvedAt: new Date(), resolvedBy: s.user.id });
    else Object.assign(set, { resolvedAt: null, resolvedBy: null });
  }
  if (patch.assignee_id !== undefined) {
    if (patch.assignee_id && !(await listAgents(deps.db)).some((a) => a.id === patch.assignee_id))
      throw new AppError('invalid_value', 'error_assignee_not_support');
    set.assigneeId = patch.assignee_id;
    // Taking an error is acknowledging it.
    if (patch.assignee_id && row.e.status === 'new' && !patch.status) set.status = 'acknowledged';
  }
  if (patch.muted_until !== undefined) set.mutedUntil = patch.muted_until ? new Date(patch.muted_until) : null;
  if (patch.note !== undefined) set.note = patch.note?.trim() || null;
  if (Object.keys(set).length) await updateErrorRow(deps.db, id, set);
  return getErrorDetail(deps, s, id);
};

const summaryLines = (e: ErrorEventRow, locale: 'he' | 'en', url: string) =>
  [
    st('errors.ticket.note', { source: e.source, code: e.code, count: e.count }, locale),
    e.message,
    `${st('errors.ticket.firstSeen', undefined, locale)} ${e.firstSeenAt.toISOString()} · ${st('errors.ticket.lastSeen', undefined, locale)} ${e.lastSeenAt.toISOString()}`,
    url,
  ].join('\n');

const errorConsoleUrl = async (deps: Pick<Deps, 'db' | 'env'>, id: string) =>
  `${await webOrigin(deps)}/owner?section=errors&error=${id}`;

/**
 * POST /platform/errors/{id}/ticket — opens a support ticket in the error's account from the console: the support
 * person is its requester, the error's summary is an internal note, nobody is emailed (first to us — decision 2).
 * From the ticket support can ask the account for access as usual.
 */
export const createTicketFromError = async (
  deps: Deps,
  s: HubActor,
  id: string,
  input: { subject?: string; note?: string },
) => {
  const e = await findErrorEvent(deps.db, id);
  if (!e) throw new AppError('not_found', 'Error not found');
  if (!e.accountId) throw new AppError('conflict', 'error_without_account');
  if (e.ticketId) throw new AppError('conflict', 'error_has_ticket');
  const settings = await loadHelpdeskSettings(deps.db);
  const now = new Date();
  const priority = settings.default_priority;
  const due = slaDue(now, await findSla(deps.db, priority), settings.business_hours);
  const queueId = (await defaultQueue(deps.db))?.id ?? null;
  const locale = s.user.locale === 'en' ? 'en' : 'he';
  const url = await errorConsoleUrl(deps, id);
  const ticketId = newId();
  const ticket = await deps.db.transaction(async (tx) => {
    const number = await nextTicketNumber(tx, settings.number_start);
    const row = await insertTicket(tx, {
      id: ticketId,
      number,
      accountId: e.accountId!,
      requesterId: s.user.id,
      requesterEmail: s.user.email,
      requesterName: s.user.name ?? '',
      subject: (input.subject?.trim() || `${e.source}: ${e.code}`).slice(0, 200),
      status: 'open',
      priority,
      categoryId: null,
      queueId,
      context: { error_event_id: e.id },
      firstResponseDueAt: due.firstResponseDueAt,
      resolutionDueAt: due.resolutionDueAt,
      createdAt: now,
      updatedAt: now,
    });
    await insertMessage(tx, {
      ticketId,
      authorId: s.user.id,
      authorName: s.user.name || s.user.email,
      kind: 'staff',
      visibility: 'internal',
      body: [input.note?.trim(), summaryLines(e, locale, url)].filter(Boolean).join('\n\n'),
    });
    await insertEvent(tx, ticketId, s.user.id, 'created', { priority, queue_id: queueId, from_error: e.id });
    await updateErrorRow(tx, e.id, {
      ticketId,
      ...(e.status === 'new' ? { status: 'acknowledged' } : {}),
      ...(e.assigneeId ? {} : { assigneeId: s.user.id }),
    });
    return row;
  });
  return {
    ticket: { id: ticket.id, number: ticket.number, url: consoleTicketUrl(await webOrigin(deps), ticket.id) },
    detail: await getErrorDetail(deps, s, id),
  };
};

/** POST /platform/errors/{id}/attach — links the error to an existing ticket of the same account (an internal note). */
export const attachErrorToTicket = async (deps: Deps, s: HubActor, id: string, input: { ticket_number: number }) => {
  const e = await findErrorEvent(deps.db, id);
  if (!e) throw new AppError('not_found', 'Error not found');
  const t = await findTicketByNumber(deps.db, input.ticket_number);
  if (!t) throw new AppError('not_found', 'Ticket not found');
  if (t.accountId !== e.accountId) throw new AppError('conflict', 'ticket_other_account');
  const locale = s.user.locale === 'en' ? 'en' : 'he';
  const url = await errorConsoleUrl(deps, id);
  await deps.db.transaction(async (tx) => {
    await insertMessage(tx, {
      ticketId: t.id,
      authorId: s.user.id,
      authorName: s.user.name || s.user.email,
      kind: 'staff',
      visibility: 'internal',
      body: summaryLines(e, locale, url),
    });
    await insertEvent(tx, t.id, s.user.id, 'error_linked', { error_event_id: e.id });
    await updateErrorRow(tx, e.id, { ticketId: t.id, ...(e.status === 'new' ? { status: 'acknowledged' } : {}) });
  });
  return getErrorDetail(deps, s, id);
};

// ---- configuration, settings, alerts ----

const mayEditSettings = (s: HubActor) => s.role === 'owner' || s.role === 'lead';

export const hubConfig = async (deps: Pick<Deps, 'db'>, s: HubActor): Promise<ErrorHubConfig> => ({
  role: s.role,
  can_edit_settings: mayEditSettings(s),
  settings: await loadErrorHubSettings(deps.db),
  agents: (await listAgents(deps.db)).map((a) => ({ id: a.id, name: a.name, email: a.email, role: a.role })),
  accounts: await accountList(deps.db),
  dropped: droppedErrors(deps.db),
});

/** PATCH /platform/errors/settings — the owner and support leads. */
export const updateHubSettings = async (deps: Pick<Deps, 'db'>, s: HubActor, patch: UpdateErrorHubSettings) => {
  if (!mayEditSettings(s)) throw new AppError('forbidden', 'support_lead_only');
  await saveErrorHubSettings(deps.db, s.user.id, patch);
  return hubConfig(deps, s);
};

/** GET /platform/errors/alerts — the console's bell: alerts sent to me. */
export const myAlerts = async (deps: Pick<Deps, 'db'>, s: HubActor) => {
  const rows = await alertsFor(deps.db, s.user.id, 50);
  const events = new Map(
    (await eventsByIds(deps.db, [...new Set(rows.flatMap((r) => r.eventIds))])).map((x) => [x.e.id, x]),
  );
  const data: ErrorAlert[] = rows.map((r) => ({
    id: r.id,
    rule_id: r.ruleId,
    rule_name: r.ruleName,
    mode: r.mode as ErrorAlert['mode'],
    total: r.total,
    events: r.eventIds.flatMap((eid) => {
      const x = events.get(eid);
      return x
        ? [
            {
              id: x.e.id,
              source: x.e.source as ErrorEvent['source'],
              severity: x.e.severity as ErrorEvent['severity'],
              code: x.e.code,
              message: x.e.message,
              count: x.e.count,
              account_name: x.accountName ?? null,
            },
          ]
        : [];
    }),
    created_at: r.createdAt.toISOString(),
    read: r.readBy.includes(s.user.id),
  }));
  return { data, unread: await unreadAlertCount(deps.db, s.user.id) };
};

export const readMyAlerts = async (deps: Pick<Deps, 'db'>, s: HubActor) => {
  await markAlertsRead(deps.db, s.user.id);
  return myAlerts(deps, s);
};

// ---- the account's Health page ----

/** GET /account-health — the account's own errors (admins), only the sources the owner made visible. */
export const accountHealth = async (
  deps: Pick<Deps, 'db'>,
  ctx: AccountContext,
  f: { state?: 'open' | 'resolved' | 'all'; source?: string; limit?: number },
  now = new Date(),
): Promise<AccountHealth> => {
  if (ctx.role !== 'admin') throw new AppError('forbidden', 'admins_only');
  const settings = await loadErrorHubSettings(deps.db);
  const page = settings.account_page;
  if (!page.enabled) return { enabled: false, open: 0, occurrences_24h: 0, data: [] };
  const sources = f.source ? page.sources.filter((x) => x === f.source) : page.sources;
  const state = f.state ?? 'open';
  const statuses = state === 'open' ? [...OPEN_ERROR_STATUSES] : state === 'resolved' ? ['resolved'] : undefined;
  const rows = await accountErrors(deps.db, ctx.accountId, { sources, statuses, limit: f.limit ?? 100 });
  const open = (
    await accountErrors(deps.db, ctx.accountId, {
      sources: page.sources,
      statuses: [...OPEN_ERROR_STATUSES],
      limit: 1000,
    })
  ).length;
  return {
    enabled: true,
    open,
    occurrences_24h: await accountOccurrencesSince(
      deps.db,
      ctx.accountId,
      page.sources,
      new Date(now.getTime() - 24 * HOUR),
    ),
    // What only support sees (assignee, notes, tickets, mutes, support's own statuses) never leaves the server.
    data: rows.map((e) => ({
      id: e.id,
      source: e.source as AccountHealth['data'][number]['source'],
      code: e.code,
      severity: e.severity as AccountHealth['data'][number]['severity'],
      message: e.message,
      links: Object.fromEntries(Object.entries(e.links ?? {}).filter(([k]) => k !== 'request_id' && k !== 'job')),
      count: e.count,
      first_seen_at: e.firstSeenAt.toISOString(),
      last_seen_at: e.lastSeenAt.toISOString(),
      state: e.status === 'resolved' ? 'resolved' : 'open',
    })),
  };
};

// ---- browser errors ----

const clientLimiters = new Map<number, RateLimiter>();
const limiterFor = (perHour: number) => {
  let l = clientLimiters.get(perHour);
  if (!l) clientLimiters.set(perHour, (l = new RateLimiter(perHour, HOUR)));
  return l;
};

/** A page path with its ids folded, so the same error on two boards is one row. */
const pageOf = (path: string | undefined) =>
  (path ?? '')
    .split('?')[0]!
    .replace(/\/[0-9A-HJKMNP-TV-Z]{26}(?=\/|$)/g, '/:id')
    .slice(0, 200);

/**
 * POST /client-errors — the browser's errors (decision 5: automatic; the page samples them by the answer's
 * `sample_rate`), scrubbed again here and limited per person and hour. The account is kept only when the person is
 * in it.
 */
export const reportClientErrors = async (
  deps: Pick<Deps, 'db'>,
  user: SessionUser,
  body: { errors: { message: string; source?: string; area?: string }[]; account_slug?: string },
) => {
  const c = (await loadErrorHubSettings(deps.db)).client;
  if (!c.enabled || !c.sample_rate) return { accepted: 0, enabled: false, sample_rate: 0 };
  let accountId: string | null = null;
  if (body.account_slug) {
    const account = await findAccountBySlug(deps.db, body.account_slug);
    const access = account ? await resolveAccountAccess(deps.db, account.id, user.id) : null;
    if (account && access && access.kind !== 'inactive') accountId = account.id;
  }
  const limiter = limiterFor(c.per_user_per_hour);
  let accepted = 0;
  for (const e of body.errors) {
    if (limiter.hit(user.id) > 0) break;
    const message = redactErrorMessage(e.message);
    const name = /^([A-Z]\w{1,40}):/.exec(message)?.[1];
    recordError(deps.db, {
      source: 'client',
      code: name ?? (e.area ? `client_${e.area}` : 'client_error'),
      message,
      accountId,
      links: { page: pageOf(e.source) },
    });
    accepted++;
  }
  return { accepted, enabled: true, sample_rate: c.sample_rate };
};
