// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AccountRole,
  type AccountSecurity,
  accountSettingsSchema,
  AppError,
  type Locale,
  type SupportMode,
} from '@bines/shared';
import { noticeEmail } from '@bines/server-mail';
import type { Db } from '../../db/client';
import { ipInRanges } from '../../lib/ip-allowlist';
import { RateLimiter } from '../../lib/rate-limit';
import { requiredScope } from '../../lib/scopes';
import { st } from '../../lib/i18n';
import type { AppDeps, SessionUser, SupportAccess } from '../../types';
import { type AccountRow, findAccountById, findMembership, getAccountSettings } from '../accounts/accounts.repo';
import { recordAudit } from '../audit/audit.repo';
import { accountMailBrand } from '../platform/mail-brand';
import { loadPlatformSettings } from '../platform/platform-settings';
import { findActiveGrantFor, type GrantRow, hasActivePeople, isPlatformOwnerUser, touchGrant } from './support.repo';
import { activeAdminsOf } from '../users/admin.repo';
import { webOrigin } from '../platform/public-address';

/**
 * Remote support access, the enforcement side. One function decides who is in an account for every
 * entrance — REST (`requireAccount`), MCP (`authenticateMcp`), the docs socket (`collab.authorize`) and the live
 * streams' re-checks: an active membership, else an active support grant (as an admin of the account). A `view`
 * grant reads only — every change answers 405 `support_read_only`; even an `edit` grant never manages people,
 * tokens, security or support access itself (no way to stay in after the grant ends). Every request under a grant
 * is in the account's audit log: changes always, reads when the owner console says so (default on), once a minute
 * per page; and the first request after a pause starts a session (audit + an email to the admins).
 */

export const modeOf = (g: Pick<GrantRow, 'scope'>): SupportMode => (g.scope === 'read_write' ? 'edit' : 'view');
export const scopeOf = (mode: SupportMode) => (mode === 'edit' ? 'read_write' : 'read');
export const supportOf = (g: GrantRow & { ticketNumber?: number | null }): SupportAccess => ({
  grantId: g.id,
  mode: modeOf(g),
  expiresAt: g.expiresAt,
  ticketId: g.ticketId ?? null,
  ticketNumber: g.ticketNumber ?? null,
});

/** The ticket of a grant for audit payloads: every row under it names the ticket. */
const ticketOf = (s: SupportAccess) =>
  s.ticketId ? { ticket_id: s.ticketId, ticket_number: s.ticketNumber ?? null } : {};

/** The DTO of a support session (`/auth/me` account.support, `/me/accounts`, the owner console). */
export const supportSessionOf = (s: SupportAccess) => ({
  grant_id: s.grantId,
  mode: s.mode,
  expires_at: s.expiresAt.toISOString(),
  ticket_id: s.ticketId ?? null,
  ticket_number: s.ticketNumber ?? null,
});

export type AccountAccess =
  | { kind: 'member'; role: AccountRole; membershipId: string; support: null }
  | { kind: 'support'; role: AccountRole; membershipId: string; support: SupportAccess }
  | { kind: 'inactive' };

/** Who this person is in this account now: a member, support by a grant, an inactive member, or nobody (null). */
export const resolveAccountAccess = async (
  db: Db,
  accountId: string,
  userId: string,
): Promise<AccountAccess | null> => {
  const m = await findMembership(db, accountId, userId);
  if (m?.status === 'active') return { kind: 'member', role: m.role, membershipId: m.id, support: null };
  const grant = await findActiveGrantFor(db, accountId, userId);
  if (grant) return { kind: 'support', role: 'admin', membershipId: grant.id, support: supportOf(grant) };
  return m ? { kind: 'inactive' } : null;
};

/** For the streams' re-checks: still in the account (member or support)? */
export const stillInAccount = async (db: Db, accountId: string, userId: string) => {
  const a = await resolveAccountAccess(db, accountId, userId);
  return !!a && a.kind !== 'inactive';
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * Never under support access, whatever the mode: managing security and support access itself, and the support
 * tickets of the account (approving one's own access request).
 */
// `auth/tokens`, `auth/service-tokens`: the account's API tokens are not support's to list (audit 2026-10-10 #15).
const NEVER = /^\/(support-access|support|security|auth\/tokens|auth\/service-tokens)(\/|$)/;
/**
 * Nor what cannot be undone or reaches beyond the content (audit 2026-10-10 #9): maintenance that deletes history
 * and notifications (tidy), emptying the trash or deleting from it for good, and the account's conversion and
 * map settings (incl. its Google key).
 */
const NEVER_WRITE = /^\/(admin\/tidy(\/|$)|trash(\/[^/]+)?$|conversions\/settings$|geo\/settings$)/;

/** A read: GET / HEAD, or a query sent as POST (`/items/query`, `/search`…, by the token scope rules). */
export const isReadRequest = (method: string, path: string) => {
  if (READ_METHODS.has(method)) return true;
  const need = requiredScope(method, path);
  return 'scope' in need && (need.scope.endsWith(':read') || need.scope === 'search');
};

/**
 * May support make this request? `path` without `/api/v1`. Reads always; in `view` nothing else (405); in `edit`
 * everything an admin may, except what would outlive the grant: people and invitations, tokens / OAuth /
 * extensions (the session-only routes), security and support access.
 */
export const assertSupportRequest = (support: SupportAccess, method: string, path: string): 'read' | 'write' => {
  if (isReadRequest(method, path)) return 'read';
  if (support.mode === 'view') throw new AppError('support_read_only', 'support_read_only');
  const need = requiredScope(method, path);
  if ('forbidden' in need || need.scope === 'users:write' || NEVER.test(path) || NEVER_WRITE.test(path))
    throw new AppError('forbidden', 'support_not_allowed');
  return 'write';
};

/** One `support.view` row per grant and page per minute (a page reads many times). */
const viewAudits = new RateLimiter(1, 60_000);

export type SupportAuditInput = {
  accountId: string;
  user: Pick<SessionUser, 'id'>;
  support: SupportAccess;
  kind: 'read' | 'write' | 'refused';
  via: 'rest' | 'mcp' | 'docs';
  /** REST: method + path + status; MCP: the tool; docs: the doc. */
  detail: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  /** The dedupe key of a read (default: the detail). */
  key?: string;
};

/** Writes the audit row of one request made under a grant (reads only when the platform logs them). */
export const auditSupportRequest = async (db: Db, e: SupportAuditInput) => {
  if (e.kind === 'read') {
    if (!(await loadPlatformSettings(db)).support.log_views) return;
    if (viewAudits.hit(`${e.support.grantId}:${e.key ?? JSON.stringify(e.detail)}`) > 0) return;
  }
  await recordAudit(db, {
    accountId: e.accountId,
    actorId: e.user.id,
    action: e.kind === 'read' ? 'support.view' : e.kind === 'write' ? 'support.action' : 'support.refused',
    targetType: 'support_grant',
    targetId: e.support.grantId,
    payload: { ...e.detail, mode: e.support.mode, via: e.via, ...ticketOf(e.support) },
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
  });
};

type MailDeps = Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>;

/** A date and time in the account's zone and the reader's language (emails). */
export const formatWhen = (date: Date, locale: Locale, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'he-IL', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone,
    }).format(date);
  } catch {
    return date.toISOString();
  }
};

export const accountTimeZone = async (db: Db, accountId: string) => {
  const parsed = accountSettingsSchema.safeParse(await getAccountSettings(db, accountId));
  return parsed.success ? parsed.data.locale.timezone : 'UTC';
};

/** The account's Security page (the emails' button: see, revoke, cancel). */
export const securityUrl = (origin: string, account: Pick<AccountRow, 'slug'>) =>
  `${origin}/a/${account.slug}/admin/security`;

/** Emails every active admin of the account (each in their own language); failures are logged, never thrown. */
export const emailAdmins = async (
  deps: MailDeps,
  account: AccountRow,
  build: (locale: Locale, timeZone: string) => { subject: string; title: string; lines: string[]; reason: string },
) => {
  const tz = await accountTimeZone(deps.db, account.id);
  for (const admin of await activeAdminsOf(deps.db, account.id)) {
    try {
      const brand = await accountMailBrand(deps, account, admin.locale);
      const c = build(brand.locale, tz);
      await deps.mailer.send(
        noticeEmail({
          to: admin.email,
          brand,
          hero: { kind: 'seal', letter: st('mail.obj.seal.support', undefined, brand.locale) },
          ...c,
          cta: {
            label: st('support.mail.cta', undefined, brand.locale),
            url: securityUrl(await webOrigin(deps), account),
          },
        }),
      );
    } catch (err) {
      deps.logger.warn({ err, accountId: account.id }, 'support notice email failed');
    }
  }
};

/**
 * Called on every request under a grant: marks it used, and when this request starts a session (first use, or the
 * first after the idle time) writes `support.session.start` and emails the account's admins (owner console setting).
 */
export const touchSupportSession = async (
  deps: MailDeps,
  p: {
    accountId: string;
    user: Pick<SessionUser, 'id' | 'email' | 'name'>;
    support: SupportAccess;
    via: 'rest' | 'mcp' | 'docs';
    ip?: string | null;
    userAgent?: string | null;
  },
) => {
  const settings = (await loadPlatformSettings(deps.db)).support;
  const started = await touchGrant(deps.db, p.support.grantId, settings.session_idle_minutes * 60_000);
  if (!started) return false;
  await recordAudit(deps.db, {
    accountId: p.accountId,
    actorId: p.user.id,
    action: 'support.session.start',
    targetType: 'support_grant',
    targetId: p.support.grantId,
    payload: {
      mode: p.support.mode,
      expires_at: p.support.expiresAt.toISOString(),
      via: p.via,
      email: p.user.email,
      ...ticketOf(p.support),
    },
    ip: p.ip ?? null,
    userAgent: p.userAgent ?? null,
  });
  if (settings.email_admins_on_entry) {
    const account = await findAccountById(deps.db, p.accountId);
    if (account)
      await emailAdmins(deps, account, (locale, tz) => {
        const vars = {
          who: p.user.name || p.user.email,
          email: p.user.email,
          account: account.name,
          mode: st(`support.mode.${p.support.mode}`, undefined, locale),
          until: formatWhen(p.support.expiresAt, locale, tz),
        };
        return {
          subject: st('support.mail.session.subject', vars, locale),
          title: st('support.mail.session.title', vars, locale),
          lines: [st('support.mail.session.body', vars, locale), st('support.mail.session.revoke', vars, locale)],
          reason: st('support.mail.reason', vars, locale),
        };
      });
  }
  return true;
};

/**
 * The IP allowlist's exceptions: the platform owner when the owner console says so
 * (default on — the way back in when an account locks itself out), and the people the account's admins exempted.
 */
export const ipExempt = async (
  db: Db,
  user: Pick<SessionUser, 'id' | 'isPlatformOwner'>,
  security: AccountSecurity,
) => {
  if (security.ip_allowlist.exempt_user_ids.includes(user.id)) return true;
  return user.isPlatformOwner && (await loadPlatformSettings(db)).support.owner_ip_exempt;
};

/** May a request from `ip` reach the account (the allowlist off, the address inside it, or the person exempt)? */
export const ipAllowedFor = async (
  db: Db,
  user: Pick<SessionUser, 'id' | 'isPlatformOwner'>,
  security: AccountSecurity,
  ip: string | null,
) =>
  !security.ip_allowlist.enabled ||
  ipInRanges(ip, security.ip_allowlist.ranges) ||
  (await ipExempt(db, user, security));

/**
 * The owner console's recovery link works only for an owner who is an active admin there, or holds
 * an active EDIT grant (a view grant must not turn into a sign-in as someone else). Otherwise 403
 * `support_grant_required` — then the emergency path (notice + wait). Invitations to the owner's own address follow the stricter `ownerMayJoin` (S-51: no grant).
 */
export const ownerMayAct = async (db: Db, ownerId: string, accountId: string) => {
  const m = await findMembership(db, accountId, ownerId);
  if (m?.status === 'active' && m.role === 'admin') return true;
  const grant = await findActiveGrantFor(db, accountId, ownerId);
  return !!grant && modeOf(grant) === 'edit';
};

export const assertOwnerMayAct = async (db: Db, ownerId: string, accountId: string) => {
  if (!(await ownerMayAct(db, ownerId, accountId)))
    throw new AppError('forbidden', 'support_grant_required', { emergency_available: true });
};

/**
 * The first admin of an account the owner console just created (`payload.first_admin`, also the bootstrap's
 * invitation to the first account): the platform owner may take it only while the account has nobody in it yet —
 * an empty account is no one else's. Once its people are in, the same invitation no longer lets an owner in.
 */
export const FIRST_ADMIN_PAYLOAD = { first_admin: true } as const;
const isFirstAdminInvitation = (inv: { payload: unknown }) =>
  !!inv.payload && typeof inv.payload === 'object' && (inv.payload as { first_admin?: unknown }).first_admin === true;

export const ownerMayTakeFirstAdmin = async (db: Db, accountId: string, inv: { payload: unknown }) =>
  isFirstAdminInvitation(inv) && !(await hasActivePeople(db, accountId));

/**
 * May a platform owner JOIN this account through this invitation (security finding S-51)? The one
 * rule for every way in, checked when an invitation is accepted — whoever issued it and from where (owner console,
 * the account's users page, a board / workspace / doc / dashboard share, the bootstrap):
 * - he is already an active member (nothing new is given), or
 * - an active admin of the account who is not a platform owner invited him (the account's own decision), or
 * - it is the first-admin invitation of an account that has nobody in it yet.
 * Never by a support grant: support access is temporary access without a membership, and a membership taken under
 * it would outlive it. Anything else is 403 `support_grant_required` — the owner's own invitation (with or without
 * a grant), one issued under a support session, one from another platform owner.
 */
export const ownerMayJoin = async (
  db: Db,
  ownerId: string,
  accountId: string,
  inv: { invitedBy: string | null; payload: unknown },
) => {
  const m = await findMembership(db, accountId, ownerId);
  if (m?.status === 'active') return true;
  if (inv.invitedBy && inv.invitedBy !== ownerId) {
    const inviter = await findMembership(db, accountId, inv.invitedBy);
    if (inviter?.status === 'active' && inviter.role === 'admin' && !(await isPlatformOwnerUser(db, inv.invitedBy)))
      return true;
  }
  return ownerMayTakeFirstAdmin(db, accountId, inv);
};

/** Accepting an invitation: a platform owner only by `ownerMayJoin`; everyone else is not concerned. */
export const assertMayJoinAccount = async (
  db: Db,
  userId: string,
  accountId: string,
  inv: { invitedBy: string | null; payload: unknown },
) => {
  if (!(await isPlatformOwnerUser(db, userId))) return;
  if (!(await ownerMayJoin(db, userId, accountId, inv)))
    throw new AppError('forbidden', 'support_grant_required', { emergency_available: false });
};
