// SPDX-License-Identifier: AGPL-3.0-only
import { ACCOUNT_ORIGINS, type AccountOrigin, AppError, isId, type Me } from '@bines/shared';
import type { Db } from '../../db/client';
import type { AppDeps, SessionUser } from '../../types';
import { findAccountById, listAccountsOfUser } from '../accounts/accounts.repo';
import { resolveAccountAccess, supportOf, supportSessionOf } from '../support/support.access';
import { findStaffRoleOf } from '../tickets/tickets.repo';
import { listActiveGrantAccountsFor } from '../support/support.repo';
import { getLastAccountId, setLastAccountId } from '../users/users.repo';
import { myAvatarUrl } from '../users/users.service';
import { twoFactorEnabledOf } from '../admin/two-factor.repo';
import { myTwoFactor } from '../admin/two-factor.service';
import { mySsoGates } from '../admin/sso-policy';
import { planStatusOf, withPlanStatus } from '../billing/plan-status';
import { loadPlatformSettings } from '../platform/platform-settings';

/** The stored origin as the DTO's enum (an unknown value reads as the owner's). */
export const originOf = (v: string | null | undefined): AccountOrigin =>
  (ACCOUNT_ORIGINS as readonly string[]).includes(v ?? '') ? (v as AccountOrigin) : 'owner';

/**
 * The account switcher: my memberships, then the accounts an active support grant lets me into (with `support`);
 * each with its plan status (`plan_status`, null = legacy — plans).
 */
export const myAccounts = async (db: Db, user: SessionUser) => {
  const mine = (await listAccountsOfUser(db, user.id)).map(({ deletionDueAt, origin, ...a }) => ({
    ...a,
    deletion_due_at: deletionDueAt?.toISOString() ?? null,
    origin: originOf(origin),
  }));
  const ids = new Set(mine.map((a) => a.id));
  const support = (await listActiveGrantAccountsFor(db, user.id))
    .filter((r) => !ids.has(r.account.id))
    .map(({ account, grant }) => ({
      id: account.id,
      name: account.name,
      slug: account.slug,
      status: account.status,
      role: 'admin' as const,
      logo_asset_id: account.logoAssetId,
      support: supportSessionOf(supportOf(grant)),
      deletion_due_at: account.deletionDueAt?.toISOString() ?? null,
      origin: originOf(account.origin),
    }));
  return withPlanStatus(db, [...mine, ...support]);
};

/** The support role of a person (agent / lead), or null. */
const supportStaffRoleOf = async (db: Db, userId: string) => {
  const row = await findStaffRoleOf(db, userId);
  return row ? (row.role === 'lead' ? ('lead' as const) : ('agent' as const)) : null;
};

/** GET /auth/me — identity, plus the account when X-Account-Id names one the user belongs to (06 §2.1). */
export const describeMe = async (
  deps: Pick<AppDeps, 'db' | 'storage'>,
  user: SessionUser,
  accountId?: string,
): Promise<Me> => {
  const { db } = deps;
  let account: Me['account'] = null;
  if (accountId && isId(accountId)) {
    const [row, access] = await Promise.all([
      findAccountById(db, accountId),
      resolveAccountAccess(db, accountId, user.id),
    ]);
    if (row && access && access.kind !== 'inactive') {
      account = {
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        role: access.role,
        // Remote support access: the app shows the support banner while this is set.
        support: access.support ? supportSessionOf(access.support) : null,
        ...(await planStatusOf(db, row.id)),
        deletion_due_at: row.deletionDueAt?.toISOString() ?? null,
        origin: originOf(row.origin),
      };
    }
  }
  const supportRole = user.isPlatformOwner ? null : await supportStaffRoleOf(db, user.id);
  const twoFactorOn = await twoFactorEnabledOf(db, user.id);
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      email_verified: user.emailVerified,
      is_platform_owner: user.isPlatformOwner,
      // Support staff: the app opens the owner console's Support section for them.
      support_role: supportRole,
      locale: user.locale,
      timezone: user.timezone,
      avatar_url: await myAvatarUrl(deps, user.id),
      two_factor: await myTwoFactor(db, user.id, twoFactorOn),
      // Plan: tokens are not sign-ins — only a cookie session has a gate.
      sso_gate: user.isService ? [] : await mySsoGates(db, user),
      // S-77: the console's two-factor requirement (only for whoever opens the console).
      console_two_factor_required:
        (user.isPlatformOwner || !!supportRole) &&
        !twoFactorOn &&
        (await loadPlatformSettings(db)).security.console_two_factor,
    },
    account,
    last_account_id: await getLastAccountId(db, user.id),
  };
};

/**
 * Remembers where `/` should land next time; only accounts the user is an active member of. An account open by
 * remote support access answers ok without being remembered (the grant ends; `/` must not land there later).
 */
export const rememberAccount = async (db: Db, user: SessionUser, accountId: string) => {
  const access = isId(accountId) ? await resolveAccountAccess(db, accountId, user.id) : null;
  if (!access || access.kind === 'inactive') throw new AppError('not_found', 'Account not found');
  if (access.kind === 'member') await setLastAccountId(db, user.id, accountId);
};
