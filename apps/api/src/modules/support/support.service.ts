// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AccountSupportSettings,
  AppError,
  type CreateSupportGrant,
  createSupportGrantSchema,
  type PlatformSupportSettings,
  type SupportAccessResponse,
  type SupportGrant,
  type SupportRecoveryRequest,
} from '@bines/shared';
import type { AppDeps, RequestMeta, SessionUser } from '../../types';
import { st } from '../../lib/i18n';
import { findAccountById, findMembership, getAccountSettings } from '../accounts/accounts.repo';
import { recordEvent } from '../activity/activity.repo';
import { recordAudit } from '../audit/audit.repo';
import { type AdminActor, securityOf } from '../admin/security.service';
import { loadPlatformSettings } from '../platform/platform-settings';
import { activeMemberByEmail, issueResetLink, limitRecoveryLinks } from '../users/recovery.service';
import { emailAdmins, formatWhen, modeOf, scopeOf, supportOf, supportSessionOf } from './support.access';
import {
  cancelRecoveryRequestRow,
  findGrant,
  findRecoveryRequest,
  type GrantRow,
  insertGrant,
  insertRecoveryRequest,
  listActiveGrantAccountsFor,
  listGrants,
  listRecoveryRequests,
  type RecoveryRequestRow,
  revokeGrantRow,
  useRecoveryRequestRow,
} from './support.repo';
import { findUserIdByEmail } from '../users/users.repo';
import { assertAccountAdmin } from '../../lib/account-admin';

/**
 * Remote support access, the management side: an account admin grants, lists and revokes; the
 * emergency recovery path of the owner console (a notice to the admins, a wait, cancellable by any admin).
 * Enforcement per request is in `support.access.ts`.
 */
type Deps = Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger' | 'auth'>;
const HOUR = 3_600_000;

/** What the grant form may offer: the platform's durations within the account's and the platform's maximum. */
export const grantOptions = (platform: PlatformSupportSettings, account: AccountSupportSettings) => {
  const max = Math.min(platform.max_duration_hours, account.max_hours);
  const list = [...new Set(platform.durations_hours)].filter((h) => h <= max).sort((x, y) => x - y);
  const durations = list.length ? list : [max];
  const fallback = durations.filter((h) => h <= platform.default_duration_hours).pop() ?? durations[0]!;
  return {
    durations_hours: durations,
    default_duration_hours: durations.includes(platform.default_duration_hours)
      ? platform.default_duration_hours
      : fallback,
    max_hours: max,
    allow_edit: account.allow_edit,
    platform_durations_hours: [...new Set(platform.durations_hours)]
      .filter((h) => h <= platform.max_duration_hours)
      .sort((x, y) => x - y),
  };
};

const grantDto = (
  r: { grant: GrantRow; grantorName: string | null; revokerName: string | null },
  now = new Date(),
): SupportGrant => ({
  id: r.grant.id,
  grantee: r.grant.granteeKind === 'email' ? 'email' : 'platform',
  email: r.grant.grantedToEmail,
  mode: modeOf(r.grant),
  reason: r.grant.reason,
  status: r.grant.revokedAt ? 'revoked' : r.grant.expiresAt <= now ? 'expired' : 'active',
  granted_by: { id: r.grant.grantedBy, name: r.grantorName },
  created_at: r.grant.createdAt.toISOString(),
  expires_at: r.grant.expiresAt.toISOString(),
  revoked_at: r.grant.revokedAt?.toISOString() ?? null,
  revoked_by_name: r.revokerName,
  last_used_at: r.grant.lastUsedAt?.toISOString() ?? null,
});

const requestDto = (
  r: { request: RecoveryRequestRow; requesterName: string | null; cancellerName: string | null },
  now = new Date(),
): SupportRecoveryRequest => ({
  id: r.request.id,
  account_id: r.request.accountId,
  email: r.request.targetEmail,
  reason: r.request.reason,
  status: r.request.cancelledAt
    ? 'cancelled'
    : r.request.usedAt
      ? 'used'
      : r.request.availableAt <= now
        ? 'ready'
        : 'waiting',
  requested_by_name: r.requesterName,
  created_at: r.request.createdAt.toISOString(),
  available_at: r.request.availableAt.toISOString(),
  cancelled_at: r.request.cancelledAt?.toISOString() ?? null,
  cancelled_by_name: r.cancellerName,
  used_at: r.request.usedAt?.toISOString() ?? null,
});

/** Support itself never manages support access (or anything that outlives the grant). */
const assertNotSupport = (a: AdminActor) => {
  if (a.ctx.support) throw new AppError('forbidden', 'support_not_allowed');
};

const accountSupportSettings = async (deps: Pick<Deps, 'db'>, accountId: string) =>
  securityOf(await getAccountSettings(deps.db, accountId)).support_access;

const audit = (
  deps: Pick<Deps, 'db'>,
  a: { accountId: string; userId: string },
  action: string,
  target: { type: string; id: string },
  payload: Record<string, unknown>,
  meta: Pick<RequestMeta, 'ip' | 'userAgent'>,
) =>
  recordAudit(deps.db, {
    accountId: a.accountId,
    actorId: a.userId,
    action,
    targetType: target.type,
    targetId: target.id,
    payload,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

/** One activity event per change: the docs socket re-checks the account's connections on `account.*` (S-24). */
const event = (deps: Pick<Deps, 'db'>, a: AdminActor, meta: RequestMeta, payload: Record<string, unknown>) =>
  recordEvent(deps.db, {
    accountId: a.ctx.accountId,
    type: 'account.support_access_changed',
    actorId: a.user.id,
    requestId: a.requestId ?? meta.requestId,
    meta: payload,
  });

/** GET /support-access — admins: every grant (newest first), the emergency requests, the form's options. */
export const getSupportAccess = async (deps: Pick<Deps, 'db'>, a: AdminActor): Promise<SupportAccessResponse> => {
  assertAccountAdmin(a.ctx);
  const [platform, account, grants, requests] = await Promise.all([
    loadPlatformSettings(deps.db),
    accountSupportSettings(deps, a.ctx.accountId),
    listGrants(deps.db, a.ctx.accountId),
    listRecoveryRequests(deps.db, [a.ctx.accountId]),
  ]);
  const now = new Date();
  const dtos = grants.map((g) => grantDto(g, now));
  const rank = { active: 0, expired: 1, revoked: 1 } as const;
  return {
    grants: [...dtos].sort((x, y) => rank[x.status] - rank[y.status]),
    recovery_requests: requests.map((r) => requestDto(r, now)),
    settings: account,
    options: grantOptions(platform.support, account),
  };
};

/**
 * POST /support-access — an admin lets support in (view by default; edit only where the account allows it).
 * `link`: approved from a support ticket's access request — the grant names the ticket, and closing
 * the ticket revokes it.
 */
export const createSupportGrant = async (
  deps: Deps,
  a: AdminActor,
  raw: CreateSupportGrant,
  meta: RequestMeta,
  link?: { ticketId: string; ticketNumber: number; accessRequestId: string },
) => {
  assertAccountAdmin(a.ctx);
  assertNotSupport(a);
  const input = createSupportGrantSchema.parse(raw);
  const [platform, account] = await Promise.all([
    loadPlatformSettings(deps.db),
    accountSupportSettings(deps, a.ctx.accountId),
  ]);
  const options = grantOptions(platform.support, account);
  if (input.mode === 'edit' && !account.allow_edit) throw new AppError('forbidden', 'support_edit_not_allowed');
  if (!options.durations_hours.includes(input.duration_hours))
    throw new AppError('invalid_value', 'support_duration_not_allowed', { allowed: options.durations_hours });
  if (input.grantee === 'email') {
    // Someone already in the account needs no grant (and a grant would never apply: membership comes first).
    const userId = await findUserIdByEmail(deps.db, input.email!);
    const m = userId ? await findMembership(deps.db, a.ctx.accountId, userId) : undefined;
    if (m?.status === 'active') throw new AppError('invalid_value', 'support_grantee_is_member');
  }
  const row = await insertGrant(deps.db, {
    accountId: a.ctx.accountId,
    grantedBy: a.user.id,
    granteeKind: input.grantee,
    grantedToEmail: input.grantee === 'email' ? input.email! : null,
    scope: scopeOf(input.mode),
    reason: input.reason,
    expiresAt: new Date(Date.now() + input.duration_hours * HOUR),
    ticketId: link?.ticketId ?? null,
  });
  const payload = {
    grantee: input.grantee,
    email: row.grantedToEmail,
    mode: input.mode,
    duration_hours: input.duration_hours,
    expires_at: row.expiresAt.toISOString(),
    reason: input.reason,
    ...(link
      ? { ticket_id: link.ticketId, ticket_number: link.ticketNumber, access_request_id: link.accessRequestId }
      : {}),
  };
  await audit(
    deps,
    { accountId: a.ctx.accountId, userId: a.user.id },
    'support.granted',
    { type: 'support_grant', id: row.id },
    payload,
    meta,
  );
  await event(deps, a, meta, { grant_id: row.id, action: 'granted', mode: input.mode });
  return grantDto({ grant: row, grantorName: a.user.name, revokerName: null });
};

/** DELETE /support-access/{id} — revoke now: the next request under it is refused, open sockets close. */
export const revokeSupportGrant = async (deps: Pick<Deps, 'db'>, a: AdminActor, id: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx);
  assertNotSupport(a);
  const grant = await findGrant(deps.db, a.ctx.accountId, id);
  if (!grant) throw new AppError('not_found', 'Grant not found');
  if (!(await revokeGrantRow(deps.db, a.ctx.accountId, id, a.user.id))) return { ok: true as const };
  await audit(
    deps,
    { accountId: a.ctx.accountId, userId: a.user.id },
    'support.revoked',
    { type: 'support_grant', id },
    {
      mode: modeOf(grant),
      expires_at: grant.expiresAt.toISOString(),
      email: grant.grantedToEmail,
      ...(grant.ticketId ? { ticket_id: grant.ticketId } : {}),
    },
    meta,
  );
  await event(deps, a, meta, { grant_id: id, action: 'revoked' });
  return { ok: true as const };
};

/** POST /support-access/recovery-requests/{id}/cancel — any admin stops an emergency recovery link. */
export const cancelRecoveryRequest = async (deps: Deps, a: AdminActor, id: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx);
  assertNotSupport(a);
  const req = await findRecoveryRequest(deps.db, id, a.ctx.accountId);
  if (!req) throw new AppError('not_found', 'Request not found');
  if (req.usedAt) throw new AppError('conflict', 'emergency_used');
  if (!(await cancelRecoveryRequestRow(deps.db, a.ctx.accountId, id, a.user.id))) return { ok: true as const };
  await audit(
    deps,
    { accountId: a.ctx.accountId, userId: a.user.id },
    'support.emergency_recovery.cancelled',
    { type: 'user', id: req.targetUserId },
    { request_id: id, email: req.targetEmail },
    meta,
  );
  await event(deps, a, meta, { request_id: id, action: 'emergency_cancelled' });
  return { ok: true as const };
};

// ---- the owner console ----

/** The accounts where this owner holds an active grant now (for "enter support" in the account list). */
export const ownerSupportSessions = async (deps: Pick<Deps, 'db'>, owner: SessionUser) =>
  new Map(
    (await listActiveGrantAccountsFor(deps.db, owner.id)).map((r) => [
      r.account.id,
      supportSessionOf(supportOf(r.grant)),
    ]),
  );

const mustFindAccount = async (deps: Pick<Deps, 'db'>, id: string) => {
  const account = await findAccountById(deps.db, id);
  if (!account) throw new AppError('not_found', 'Account not found');
  return account;
};

/**
 * POST /platform/accounts/{id}/emergency-recovery — no grant (e.g. the only admin is locked out): the request is
 * announced to every admin of the account at once and the link can be made only after the platform's wait
 * (owner console, default 24 h). Any admin may cancel it until then.
 */
export const requestEmergencyRecovery = async (
  deps: Deps,
  owner: SessionUser,
  accountId: string,
  input: { email: string; reason: string },
  meta: RequestMeta,
) => {
  const account = await mustFindAccount(deps, accountId);
  const { userId, user } = await activeMemberByEmail(deps, accountId, input.email);
  const settings = (await loadPlatformSettings(deps.db)).support;
  const row = await insertRecoveryRequest(deps.db, {
    accountId,
    requestedBy: owner.id,
    targetUserId: userId,
    targetEmail: user.email,
    reason: input.reason,
    availableAt: new Date(Date.now() + settings.emergency_delay_hours * HOUR),
  });
  await audit(
    deps,
    { accountId, userId: owner.id },
    'support.emergency_recovery.requested',
    { type: 'user', id: userId },
    {
      request_id: row.id,
      email: user.email,
      reason: input.reason,
      available_at: row.availableAt.toISOString(),
      via: 'platform_owner',
    },
    meta,
  );
  await emailAdmins(deps, account, (locale, tz) => {
    const vars = {
      who: owner.name || owner.email,
      email: user.email,
      account: account.name,
      reason: input.reason,
      when: formatWhen(row.availableAt, locale, tz),
      hours: settings.emergency_delay_hours,
    };
    return {
      subject: st('support.mail.emergency.subject', vars, locale),
      title: st('support.mail.emergency.title', vars, locale),
      lines: [
        st('support.mail.emergency.body', vars, locale),
        st('support.mail.emergency.reason', vars, locale),
        st('support.mail.emergency.cancel', vars, locale),
      ],
      reason: st('support.mail.reason', vars, locale),
    };
  });
  return requestDto({ request: row, requesterName: owner.name, cancellerName: null });
};

/** GET /platform/accounts/{id}/emergency-recovery (one account) and /platform/emergency-recovery (all). */
export const listEmergencyRecovery = async (deps: Pick<Deps, 'db'>, accountId: string | null) => {
  if (accountId) await mustFindAccount(deps, accountId);
  const now = new Date();
  return (await listRecoveryRequests(deps.db, accountId ? [accountId] : null)).map((r) => requestDto(r, now));
};

/** POST /platform/emergency-recovery/{id}/link — after the wait, not cancelled: the one-time link (single use). */
export const emergencyRecoveryLink = async (deps: Deps, owner: SessionUser, id: string, meta: RequestMeta) => {
  const req = await findRecoveryRequest(deps.db, id);
  if (!req) throw new AppError('not_found', 'Request not found');
  const account = await mustFindAccount(deps, req.accountId);
  if (req.cancelledAt) throw new AppError('conflict', 'emergency_cancelled');
  if (req.usedAt) throw new AppError('conflict', 'emergency_used');
  if (req.availableAt > new Date())
    throw new AppError('conflict', 'emergency_waiting', { available_at: req.availableAt.toISOString() });
  // Still an active member (deactivated in the meantime → refused).
  const { userId, user } = await activeMemberByEmail(deps, req.accountId, req.targetEmail);
  limitRecoveryLinks(owner.id);
  if (!(await useRecoveryRequestRow(deps.db, id))) throw new AppError('conflict', 'emergency_used');
  const link = await issueResetLink(deps, userId);
  await audit(
    deps,
    { accountId: req.accountId, userId: owner.id },
    'user.recovery_link_created',
    { type: 'user', id: userId },
    { email: user.email, expires_at: link.expires_at, via: 'platform_owner', emergency_request_id: id },
    meta,
  );
  await emailAdmins(deps, account, (locale) => {
    const vars = { who: owner.name || owner.email, email: user.email, account: account.name };
    return {
      subject: st('support.mail.emergencyUsed.subject', vars, locale),
      title: st('support.mail.emergencyUsed.title', vars, locale),
      lines: [st('support.mail.emergencyUsed.body', vars, locale)],
      reason: st('support.mail.reason', vars, locale),
    };
  });
  return link;
};
