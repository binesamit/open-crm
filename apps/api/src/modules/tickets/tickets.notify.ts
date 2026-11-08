// SPDX-License-Identifier: AGPL-3.0-only
import type { Locale, TicketArticle } from '@bines/shared';
import { type Hero, type NoticeLinks, noticeEmail } from '@bines/server-mail';
import type { AppDeps } from '../../types';
import { asLocale, st } from '../../lib/i18n';
import type { AccountRow } from '../accounts/accounts.repo';
import { notifyUsers } from '../notifications/notify';
import { platformMailBrand } from '../platform/mail-brand';
import { webOrigin } from '../platform/public-address';
import { loadHelpdeskSettings } from './tickets.settings';
import { activeAdminsOf } from '../users/admin.repo';
import { type AccessRequestRow, findUser, isActiveMember, listAgents, type TicketRow } from './tickets.repo';

/**
 * What a ticket tells people: the customer gets an email (the platform's brand, their language) and a
 * bell notification; account admins hear about access requests; staff are emailed about new tickets and customer
 * replies. Every email is a setting (owner console → Support → Settings). Bell rows are marked emailed, so the
 * notification worker never sends a second, generic email for them. Failures are logged, never thrown.
 */
type Deps = Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>;

/** `origin` = the platform's public address (owner console, M11; else WEB_ORIGIN). */
export const ticketUrl = (origin: string, account: Pick<AccountRow, 'slug'>, ticketId: string, query = '') =>
  `${origin}/a/${account.slug}/support/${ticketId}${query}`;
export const consoleTicketUrl = (origin: string, ticketId: string) =>
  `${origin}/owner?section=support&ticket=${ticketId}`;

const vars = (t: TicketRow, account: Pick<AccountRow, 'name'>, extra: Record<string, string | number> = {}) => ({
  number: t.number,
  subject: t.subject,
  account: account.name,
  ...extra,
});

const send = async (
  deps: Deps,
  to: { email: string; locale: string | null },
  build: (
    locale: Locale,
    product: string,
    origin: string,
  ) => {
    subject: string;
    title: string;
    lines: string[];
    links?: NoticeLinks;
    cta?: { label: string; url: string };
    hero?: Hero;
  },
) => {
  try {
    const brand = await platformMailBrand(deps, to.locale);
    const c = build(brand.locale, brand.product, await webOrigin(deps));
    await deps.mailer.send(
      noticeEmail({
        to: to.email,
        brand,
        ...c,
        reason: st('tickets.mail.reason', { product: brand.product, email: to.email }, brand.locale),
      }),
    );
  } catch (err) {
    deps.logger.warn({ err: String(err) }, 'ticket email failed');
  }
};

const bell = async (
  deps: Deps,
  t: TicketRow,
  userIds: string[],
  type: 'ticket_reply' | 'ticket_status' | 'ticket_access_request',
  actorId: string | null,
  excerpt: string,
) => {
  const to: string[] = [];
  for (const id of new Set(userIds)) if (await isActiveMember(deps.db, t.accountId, id)) to.push(id);
  await notifyUsers(
    deps.db,
    {
      accountId: t.accountId,
      type,
      actorId,
      // The tickets module sends its own email (with the ticket's settings); the generic worker email is skipped.
      email: false,
      payload: { excerpt, ticket: { id: t.id, number: t.number, subject: t.subject } },
    },
    to,
  );
};

/** The luggage tag of a ticket (objects style): its number, priority, status and subject. */
const ticketTag = (t: TicketRow, locale: Locale): Hero => ({
  kind: 'tag',
  numberLabel: st('mail.obj.tag.number', undefined, locale),
  number: String(t.number),
  subject: t.subject,
  fields: [
    [st('mail.obj.tag.priority', undefined, locale), st(`tickets.priority.${t.priority}`, undefined, locale)],
    [st('mail.obj.tag.status', undefined, locale), st(`tickets.status.${t.status}`, undefined, locale)],
  ],
});

const requesterOf = async (deps: Deps, t: TicketRow) => {
  const user = t.requesterId ? await findUser(deps.db, t.requesterId) : undefined;
  return { id: user?.id ?? null, email: user?.email ?? t.requesterEmail, locale: user?.locale ?? null };
};

/** "We got your ticket #1042". */
export const notifyCreated = async (deps: Deps, t: TicketRow, account: AccountRow) => {
  const settings = await loadHelpdeskSettings(deps.db);
  if (!settings.email.customer_on_create) return;
  const to = await requesterOf(deps, t);
  await send(deps, to, (locale, product, origin) => {
    const v = vars(t, account, { product });
    return {
      subject: st('tickets.mail.created.subject', v, locale),
      title: st('tickets.mail.created.title', v, locale),
      lines: [st('tickets.mail.created.body', v, locale)],
      hero: ticketTag(t, locale),
      cta: { label: st('tickets.mail.open', v, locale), url: ticketUrl(origin, account, t.id) },
    };
  });
};

/** A staff reply reached the customer: email + bell. */
export const notifyReply = async (
  deps: Deps,
  t: TicketRow,
  account: AccountRow,
  reply: {
    body: string;
    authorId: string;
    authorName: string;
    /** Knowledge-center articles attached to the reply: the email lists them with their links. */
    articles?: Pick<TicketArticle, 'title' | 'excerpt' | 'url'>[];
  },
) => {
  const settings = await loadHelpdeskSettings(deps.db);
  const to = await requesterOf(deps, t);
  const articles = reply.articles ?? [];
  if (to.id)
    await bell(deps, t, [to.id], 'ticket_reply', reply.authorId, reply.body || articles.map((a) => a.title).join(', '));
  if (!settings.email.customer_on_reply) return;
  await send(deps, to, (locale, product, origin) => {
    const v = vars(t, account, { product, who: reply.authorName });
    return {
      subject: st('tickets.mail.reply.subject', v, locale),
      title: st('tickets.mail.reply.title', v, locale),
      hero: { kind: 'thread', who: reply.authorName },
      lines: [...(reply.body ? [reply.body] : []), ...(settings.signature.trim() ? [settings.signature.trim()] : [])],
      ...(articles.length
        ? {
            links: {
              title: st('tickets.mail.reply.articles', v, locale),
              items: articles.map((a) => ({ label: a.title, url: a.url, note: a.excerpt })),
            },
          }
        : {}),
      cta: { label: st('tickets.mail.open', v, locale), url: ticketUrl(origin, account, t.id) },
    };
  });
};

/** The status changed by staff (solved, waiting for you…): email + bell. */
export const notifyStatus = async (deps: Deps, t: TicketRow, account: AccountRow, actorId: string | null) => {
  const settings = await loadHelpdeskSettings(deps.db);
  const to = await requesterOf(deps, t);
  const label = (locale: Locale) => st(`tickets.status.${t.status}`, undefined, locale);
  if (to.id) await bell(deps, t, [to.id], 'ticket_status', actorId, label(asLocale(to.locale)));
  if (!settings.email.customer_on_status) return;
  await send(deps, to, (locale, product, origin) => {
    const v = vars(t, account, { product, status: label(locale) });
    return {
      subject: st('tickets.mail.status.subject', v, locale),
      title: st('tickets.mail.status.title', v, locale),
      hero: {
        kind: 'flaps',
        head: st('mail.obj.flaps.head', undefined, locale),
        rows: [
          { label: st('mail.obj.flaps.ticket', undefined, locale), value: String(t.number), ltr: true },
          { label: st('mail.obj.flaps.now', undefined, locale), value: label(locale), accent: true },
        ],
      },
      lines: [
        st(t.status === 'solved' ? 'tickets.mail.status.solved' : 'tickets.mail.status.body', v, locale),
        ...(t.status === 'solved' && settings.csat.enabled ? [st('tickets.mail.status.rate', v, locale)] : []),
      ],
      cta: { label: st('tickets.mail.open', v, locale), url: ticketUrl(origin, account, t.id) },
    };
  });
};

/** Support asks to enter the account: every active admin — a bell notification and an email with "approve". */
export const notifyAccessRequest = async (
  deps: Deps,
  t: TicketRow,
  account: AccountRow,
  r: AccessRequestRow,
  staff: { id: string; name: string },
) => {
  const admins = await activeAdminsOf(deps.db, t.accountId);
  await bell(
    deps,
    t,
    admins.map((a) => a.id),
    'ticket_access_request',
    staff.id,
    r.reason,
  );
  for (const admin of admins)
    await send(deps, admin, (locale, product, origin) => {
      const v = vars(t, account, {
        product,
        who: staff.name,
        mode: st(`support.mode.${r.mode}`, undefined, locale),
        hours: r.durationHours,
        reason: r.reason,
      });
      return {
        subject: st('tickets.mail.access.subject', v, locale),
        title: st('tickets.mail.access.title', v, locale),
        hero: { kind: 'seal', letter: st('mail.obj.seal.support', undefined, locale) },
        lines: [st('tickets.mail.access.body', v, locale), st('tickets.mail.access.reason', v, locale)],
        cta: {
          label: st('tickets.mail.access.approve', v, locale),
          url: ticketUrl(origin, account, t.id, `?approve=${r.id}`),
        },
      };
    });
};

/** The person who asked for access hears the admin's answer. */
export const notifyAccessDecision = async (
  deps: Deps,
  t: TicketRow,
  account: AccountRow,
  r: AccessRequestRow,
  decision: 'approved' | 'declined',
) => {
  const staff = await findUser(deps.db, r.requestedBy);
  if (!staff) return;
  await send(deps, staff, (locale, product, origin) => {
    const v = vars(t, account, { product, hours: r.durationHours });
    return {
      subject: st(`tickets.mail.${decision}.subject`, v, locale),
      title: st(`tickets.mail.${decision}.subject`, v, locale),
      lines: [st(`tickets.mail.${decision}.body`, v, locale)],
      cta: { label: st('tickets.mail.openConsole', v, locale), url: consoleTicketUrl(origin, t.id) },
    };
  });
};

/**
 * Staff hear about a new ticket or a customer reply: the assignee, else every lead and platform owner (settings:
 * `staff_on_new`, `staff_on_customer_reply`).
 */
export const notifyStaff = async (
  deps: Deps,
  t: TicketRow,
  account: AccountRow,
  kind: 'new' | 'customer_reply',
  excerpt: string,
) => {
  const settings = await loadHelpdeskSettings(deps.db);
  if (kind === 'new' ? !settings.email.staff_on_new : !settings.email.staff_on_customer_reply) return;
  const agents = await listAgents(deps.db);
  const to = t.assigneeId
    ? agents.filter((a) => a.id === t.assigneeId)
    : agents.filter((a) => a.role === 'lead' || a.role === 'owner');
  for (const a of to) {
    const user = await findUser(deps.db, a.id);
    await send(deps, { email: a.email, locale: user?.locale ?? null }, (locale, product, origin) => {
      const v = vars(t, account, { product });
      return {
        subject: st(`tickets.mail.staff.${kind}.subject`, v, locale),
        title: st(`tickets.mail.staff.${kind}.subject`, v, locale),
        hero: ticketTag(t, locale),
        lines: [excerpt.slice(0, 2000)],
        cta: { label: st('tickets.mail.openConsole', v, locale), url: consoleTicketUrl(origin, t.id) },
      };
    });
  }
};

/** A new support person is told where the console is. */
export const notifyStaffInvited = async (deps: Deps, email: string, role: string, locale: string | null) =>
  send(deps, { email, locale }, (l, product, origin) => {
    const v = { product, role: st(`tickets.staff.role.${role}`, undefined, l) };
    return {
      subject: st('tickets.mail.staffInvite.subject', v, l),
      title: st('tickets.mail.staffInvite.subject', v, l),
      lines: [st('tickets.mail.staffInvite.body', v, l)],
      cta: { label: st('tickets.mail.openConsole', v, l), url: `${origin}/owner?section=support` },
    };
  });
