// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AccountSecurity,
  accountSecuritySchema,
  type AccountSession,
  AppError,
  type SecuritySettings,
  type UpdateSecurity,
  updateSecuritySchema,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { ipInRanges } from '../../lib/ip-allowlist';
import type { AccountContext, AppDeps, RequestMeta, SessionUser } from '../../types';
import { findMembership, getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';
import { recordEvent } from '../activity/activity.repo';
import { recordAudit } from '../audit/audit.repo';
import { adminsElsewhere, deleteSessions, listMemberSessions, usersActiveElsewhere } from './admin.repo';
import { forgetSecurity } from './two-factor.service';
import { platformPasswordMin } from '../../auth/password-policy';
import { assertSsoPolicySavable } from './sso-policy';
import { assertAccountAdmin } from '../../lib/account-admin';

/**
 * Administration → אבטחה (08 §5, account admin A4): the account's sign-ins with sign-out, allowed domains,
 * auto-join (stored; sign-up still needs an invitation), the guest domain policy, the two-factor policy and the IP
 * allowlist (M8 ד12). Admins only.
 */
export type AdminActor = { ctx: AccountContext; user: SessionUser; requestId?: string; sessionId?: string | null };
type Deps = Pick<AppDeps, 'db'>;

/** `settings.security` as stored (defaults filled in). */
export const securityOf = (settings: Record<string, unknown>): AccountSecurity => {
  const parsed = accountSecuritySchema.safeParse(settings.security ?? {});
  return parsed.success ? parsed.data : accountSecuritySchema.parse({});
};

const domainsOf = (settings: Record<string, unknown>) =>
  Array.isArray(settings.domains) ? (settings.domains as unknown[]).filter((d) => typeof d === 'string') : [];

const view = (settings: Record<string, unknown>): SecuritySettings => ({
  ...securityOf(settings),
  domains: domainsOf(settings) as string[],
});

export const getSecurity = async (deps: Deps, a: AdminActor, meta?: Pick<RequestMeta, 'ip'>) => {
  assertAccountAdmin(a.ctx);
  return {
    ...view(await getAccountSettings(deps.db, a.ctx.accountId)),
    current_ip: meta?.ip ?? null,
    platform_password_min_length: await platformPasswordMin(deps.db),
  };
};

/**
 * The next security settings from a patch. The 2FA policy's `required_since` is the server's: set when a
 * requirement starts or widens (optional → admins → everyone), so the newly covered people get the grace period;
 * kept when it narrows or only the grace changes; cleared when 2FA becomes optional again.
 */
const nextSecurity = (current: AccountSecurity, patch: Omit<UpdateSecurity, 'domains'>, now: Date): AccountSecurity => {
  const { two_factor, ip_allowlist, support_access, sso, ...rest } = patch;
  const next = { ...current, ...rest };
  if (two_factor) {
    const rank = { optional: 0, required_admins: 1, required_all: 2 } as const;
    const widened = rank[two_factor.mode] > rank[current.two_factor.mode];
    next.two_factor = {
      mode: two_factor.mode,
      grace_days: two_factor.grace_days ?? current.two_factor.grace_days,
      required_since:
        two_factor.mode === 'optional'
          ? null
          : widened || !current.two_factor.required_since
            ? now.toISOString()
            : current.two_factor.required_since,
    };
  }
  if (ip_allowlist) {
    next.ip_allowlist = {
      enabled: ip_allowlist.enabled ?? current.ip_allowlist.enabled,
      ranges: [...new Set(ip_allowlist.ranges ?? current.ip_allowlist.ranges)],
      exempt_user_ids: [...new Set(ip_allowlist.exempt_user_ids ?? current.ip_allowlist.exempt_user_ids)],
    };
  }
  if (support_access) next.support_access = { ...current.support_access, ...support_access };
  if (sso)
    next.sso = {
      ...current.sso,
      ...sso,
      ...(sso.providers ? { providers: [...new Set(sso.providers)] } : {}),
      ...(sso.domains ? { domains: [...new Set(sso.domains)] } : {}),
      ...(sso.google_domains ? { google_domains: [...new Set(sso.google_domains)] } : {}),
      ...(sso.microsoft_tenants ? { microsoft_tenants: [...new Set(sso.microsoft_tenants)] } : {}),
    };
  return accountSecuritySchema.parse(next);
};

const audit = (
  db: Db,
  a: AdminActor,
  meta: RequestMeta,
  action: string,
  target: { type: string; id: string },
  payload: Record<string, unknown>,
) =>
  recordAudit(db, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action,
    targetType: target.type,
    targetId: target.id,
    payload,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

/** PATCH /security — only what was sent changes; one `account.updated` event and a `security.settings_changed` row. */
export const updateSecurity = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  a: AdminActor,
  raw: UpdateSecurity,
  meta: RequestMeta,
) => {
  assertAccountAdmin(a.ctx);
  const input = updateSecuritySchema.parse(raw);
  // Plan: "sign in through Google / Microsoft only" needs an offered provider and never shuts out the saver.
  if (input.sso) {
    const current = securityOf(await getAccountSettings(deps.db, a.ctx.accountId));
    await assertSsoPolicySavable(deps, nextSecurity(current, { sso: input.sso }, new Date()).sso, a.ctx.role, a.user);
  }
  const result = await deps.db.transaction(async (tx) => {
    const settings = await getAccountSettings(tx, a.ctx.accountId);
    const before = view(settings);
    const { domains, ...rest } = input;
    const security = nextSecurity(securityOf(settings), rest, new Date());
    // People exempt from the IP allowlist are people of this account.
    if (rest.ip_allowlist?.exempt_user_ids)
      for (const id of security.ip_allowlist.exempt_user_ids)
        if (!(await findMembership(tx, a.ctx.accountId, id)))
          throw new AppError('invalid_value', 'ip_exempt_not_member', { user_id: id });
    // The IP allowlist can never lock out the admin saving it: on, it must contain the address of this request.
    if (security.ip_allowlist.enabled) {
      if (!security.ip_allowlist.ranges.length) throw new AppError('invalid_value', 'ip_allowlist_empty');
      if (!meta.ip) throw new AppError('invalid_value', 'ip_unknown');
      if (!ipInRanges(meta.ip, security.ip_allowlist.ranges))
        throw new AppError('invalid_value', 'ip_allowlist_excludes_you', { ip: meta.ip });
    }
    const next = {
      ...settings,
      ...(domains ? { domains: [...new Set(domains)] } : {}),
      security,
    };
    const after = view(next);
    const changed = (Object.keys(after) as (keyof SecuritySettings)[]).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    if (!changed.length) return after;
    await upsertAccountSettings(tx, a.ctx.accountId, next, a.user.id);
    const b = Object.fromEntries(changed.map((k) => [k, before[k]]));
    const n = Object.fromEntries(changed.map((k) => [k, after[k]]));
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'account.updated',
      actorId: a.user.id,
      requestId: a.requestId ?? meta.requestId,
      before: { security: b },
      after: { security: n },
    });
    await audit(
      tx,
      a,
      meta,
      'security.settings_changed',
      { type: 'account', id: a.ctx.accountId },
      {
        fields: changed,
        before: b,
        after: n,
      },
    );
    // The two that decide who gets in have their own rows too (M8 ד12), easy to filter in the audit log.
    if (changed.includes('two_factor'))
      await audit(
        tx,
        a,
        meta,
        'auth.2fa.policy_changed',
        { type: 'account', id: a.ctx.accountId },
        {
          before: before.two_factor,
          after: after.two_factor,
        },
      );
    if (changed.includes('sso'))
      await audit(
        tx,
        a,
        meta,
        'security.sso_policy_changed',
        { type: 'account', id: a.ctx.accountId },
        { before: before.sso, after: after.sso },
      );
    if (changed.includes('ip_allowlist'))
      await audit(
        tx,
        a,
        meta,
        'security.ip_allowlist_changed',
        { type: 'account', id: a.ctx.accountId },
        {
          before: before.ip_allowlist,
          after: after.ip_allowlist,
        },
      );
    return after;
  });
  forgetSecurity(a.ctx.accountId);
  return { ...result, current_ip: meta.ip, platform_password_min_length: await platformPasswordMin(deps.db) };
};

// ---- sessions ----
const SESSIONS_SHOWN = 200;
export const listSessions = async (deps: Deps, a: AdminActor): Promise<AccountSession[]> => {
  assertAccountAdmin(a.ctx);
  const rows = await listMemberSessions(deps.db, a.ctx.accountId);
  const ids = [...new Set(rows.map((r) => r.userId))];
  const [elsewhere, adminElsewhere] = await Promise.all([
    usersActiveElsewhere(deps.db, a.ctx.accountId, ids),
    adminsElsewhere(deps.db, a.ctx.accountId, ids),
  ]);
  // The most recent sessions only (a long-lived account piles up thousands); this device always stays in the list.
  const recent = [...rows].sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime());
  const shown = recent.slice(0, SESSIONS_SHOWN);
  const mine = a.sessionId ? recent.find((r) => r.id === a.sessionId) : undefined;
  if (mine && !shown.includes(mine)) shown.unshift(mine);
  return shown.map((r) => ({
    id: r.id,
    user_id: r.userId,
    user_name: r.name,
    user_email: r.email,
    ip: r.ip,
    user_agent: r.userAgent,
    created_at: r.createdAt.toISOString(),
    last_seen_at: r.updatedAt.toISOString(),
    expires_at: r.expiresAt.toISOString(),
    current: !!a.sessionId && r.id === a.sessionId,
    other_accounts: elsewhere.has(r.userId),
    admin_elsewhere: r.userId !== a.user.id && adminElsewhere.has(r.userId),
  }));
};

/**
 * DELETE /security/sessions/:id — signs one sign-in out. Sessions are global (D12): the person is signed out of
 * every account on that device. Not my current session (sign out instead); not the platform owner's; not someone
 * who is an admin of another account (S-15) — one account's admin does not lock another account's admin out.
 */
export const signOutSession = async (deps: Deps, a: AdminActor, sessionId: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx);
  const found = (await listMemberSessions(deps.db, a.ctx.accountId)).find((s) => s.id === sessionId);
  if (!found) throw new AppError('not_found', 'Session not found');
  if (found.id === a.sessionId) throw new AppError('forbidden', 'own_session');
  if (found.isPlatformOwner && found.userId !== a.user.id) throw new AppError('forbidden', 'platform_owner');
  if (found.userId !== a.user.id && (await adminsElsewhere(deps.db, a.ctx.accountId, [found.userId])).size)
    throw new AppError('forbidden', 'admin_of_other_account');
  await deps.db.transaction(async (tx) => {
    await deleteSessions(tx, [found.id]);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'security.session_signed_out',
      actorId: a.user.id,
      requestId: a.requestId ?? meta.requestId,
      meta: { user_id: found.userId, session_id: found.id },
    });
    await audit(
      tx,
      a,
      meta,
      'session.signed_out',
      { type: 'user', id: found.userId },
      {
        session_id: found.id,
        session_ip: found.ip,
        session_user_agent: found.userAgent,
      },
    );
  });
  return { signed_out: 1 };
};

/**
 * POST /security/sessions/sign-out-all — every sign-in of the account's people except mine, the platform owner's
 * and those of admins of other accounts (S-15; counted in `skipped`). One event and one audit row.
 */
export const signOutAll = async (deps: Deps, a: AdminActor, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx);
  const candidates = (await listMemberSessions(deps.db, a.ctx.accountId)).filter(
    (s) => s.userId !== a.user.id && !s.isPlatformOwner,
  );
  const protectedUsers = await adminsElsewhere(deps.db, a.ctx.accountId, [...new Set(candidates.map((s) => s.userId))]);
  const rows = candidates.filter((s) => !protectedUsers.has(s.userId));
  const skipped = candidates.length - rows.length;
  const users = [...new Set(rows.map((r) => r.userId))];
  await deps.db.transaction(async (tx) => {
    const gone = await deleteSessions(
      tx,
      rows.map((r) => r.id),
    );
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'security.sessions_signed_out',
      actorId: a.user.id,
      requestId: a.requestId ?? meta.requestId,
      meta: { sessions: gone.length, users: users.length, skipped },
    });
    await audit(
      tx,
      a,
      meta,
      'session.signed_out_all',
      { type: 'account', id: a.ctx.accountId },
      {
        sessions: gone.length,
        user_ids: users,
        skipped_admins_elsewhere: [...protectedUsers],
      },
    );
  });
  return { signed_out: rows.length, skipped };
};
