// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AccountRole,
  type AccountSecurity,
  accountSecuritySchema,
  AppError,
  canAccount,
  type MyTwoFactor,
  type TwoFactorPolicy,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { AppDeps, RequestMeta, SessionUser, Actor } from '../../types';
import { getAccountSettings } from '../accounts/accounts.repo';
import { recordEvent } from '../activity/activity.repo';
import { recordAudit } from '../audit/audit.repo';
import { assertMayTakeOverSignIn, findMemberWithUser } from '../users/admin.repo';
import { activeMembershipsWithSettings, removeTwoFactor } from './two-factor.repo';

/**
 * Two-factor authentication (M8 ד12, D25): optional for everyone; an account admin may require it for admins or for
 * everyone, with a grace period. Sessions are global (D12), so a person's requirement is the strictest of their
 * accounts; each account also enforces its own rule on its own pages (`requireAccount` → 403 two_factor_required).
 */
const DAY = 86_400_000;

const securityOf = (settings: Record<string, unknown> | null | undefined): AccountSecurity => {
  const parsed = accountSecuritySchema.safeParse(settings?.security ?? {});
  return parsed.success ? parsed.data : accountSecuritySchema.parse({});
};

export const requiresTwoFactor = (policy: TwoFactorPolicy, role: AccountRole) =>
  policy.mode === 'required_all' || (policy.mode === 'required_admins' && role === 'admin');

/** When the grace period of a requirement ends (a requirement with no start date applies at once). */
export const twoFactorDeadline = (policy: TwoFactorPolicy): Date =>
  new Date((policy.required_since ? Date.parse(policy.required_since) : 0) + policy.grace_days * DAY);

// ---- the account's security settings, per request (requireAccount) ----
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; value: AccountSecurity }>();

/** `settings.security` of an account, cached for a few seconds (every account request reads it). */
export const cachedSecurity = async (db: Db, accountId: string): Promise<AccountSecurity> => {
  const hit = cache.get(accountId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = securityOf(await getAccountSettings(db, accountId));
  cache.set(accountId, { at: Date.now(), value });
  return value;
};

/** Called when an account's security settings change in this process. */
export const forgetSecurity = (accountId: string) => cache.delete(accountId);

/** My state across my accounts: the earliest deadline of those that require 2FA for my role there. */
export const myTwoFactor = async (db: Db, userId: string, enabled: boolean, now = new Date()): Promise<MyTwoFactor> => {
  let deadline: Date | null = null;
  for (const m of await activeMembershipsWithSettings(db, userId)) {
    const policy = securityOf(m.settings).two_factor;
    if (!requiresTwoFactor(policy, m.role)) continue;
    const d = twoFactorDeadline(policy);
    if (!deadline || d < deadline) deadline = d;
  }
  return {
    enabled,
    required: !!deadline,
    deadline: deadline?.toISOString() ?? null,
    must_enroll: !!deadline && !enabled && now >= deadline,
  };
};

/**
 * The account's own gate (requireAccount): a person its policy covers, without 2FA, past the grace period, gets
 * 403 two_factor_required until they turn it on (the profile / enrolment screen is outside the account's API).
 * S-53: an API token, an MCP connection and an OAuth consent are held to it too — they act as the person, so a
 * token made before the policy (or by someone who never enrolled) stops with the same 403 until the person enrols.
 * Service identities and extension tokens (minted from a gated session) are not asked.
 */
export const assertTwoFactorGate = (
  security: AccountSecurity,
  role: AccountRole,
  user: Pick<SessionUser, 'isService' | 'twoFactorEnabled'>,
  now = new Date(),
) => {
  if (twoFactorGateBlocks(security, role, user, now)) throw new AppError('forbidden', 'two_factor_required');
};

/** Would the account's gate stop this person now (the non-throwing form — the OAuth consent screen's reasons)? */
export const twoFactorGateBlocks = (
  security: AccountSecurity,
  role: AccountRole,
  user: Pick<SessionUser, 'isService' | 'twoFactorEnabled'>,
  now = new Date(),
) => {
  const policy = security.two_factor;
  if (user.isService || user.twoFactorEnabled || !requiresTwoFactor(policy, role)) return false;
  return now >= twoFactorDeadline(policy);
};

/** One audit row in every account the person is active in (2FA is per person, not per account). */
export const auditForUser = async (
  db: Db,
  userId: string,
  action: string,
  payload: Record<string, unknown>,
  meta: { ip: string | null; userAgent: string | null },
) => {
  for (const m of await activeMembershipsWithSettings(db, userId)) {
    await recordAudit(db, {
      accountId: m.accountId,
      actorId: userId,
      action,
      targetType: 'user',
      targetId: userId,
      payload,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
};

/**
 * POST /users/:id/reset-2fa — an admin turns a member's 2FA off (lost phone, no backup codes): the same rules as the
 * recovery link — admins only, never yourself (the profile is for that), never a deactivated member, never the
 * platform owner unless you are them, never someone also active in another account (their second factor guards
 * that account too — the platform owner does that one). Audited `auth.2fa.reset`.
 */
export const resetMemberTwoFactor = async (deps: Pick<AppDeps, 'db'>, a: Actor, userId: string, meta: RequestMeta) => {
  const decision = canAccount(a.ctx.role, 'users.manage');
  if (!decision.ok) throw new AppError('forbidden', decision.reason);
  const m = await findMemberWithUser(deps.db, a.ctx.accountId, userId);
  if (!m) throw new AppError('not_found', 'User not found');
  if (userId === a.user.id) throw new AppError('forbidden', 'self');
  if (m.membership.status !== 'active') throw new AppError('forbidden', 'user_not_active');
  // S-52: never someone whose sign-in opens more than this account — the platform owner does those from the owner
  // console (`ownerResetTwoFactor`), with a support grant; no bypass inside an account (audit 2026-10-10 #26).
  await assertMayTakeOverSignIn(deps.db, a.ctx.accountId, userId);
  if (!m.user.twoFactorEnabled) throw new AppError('conflict', 'two_factor_not_enabled');
  await deps.db.transaction(async (tx) => {
    await removeTwoFactor(tx, userId);
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'auth.2fa.reset',
      targetType: 'user',
      targetId: userId,
      payload: { email: m.user.email },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'user.two_factor_reset',
      actorId: a.user.id,
      requestId: a.requestId ?? meta.requestId,
      meta: { user_id: userId },
    });
  });
  return { ok: true as const };
};
