// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AccountRole,
  type AccountSecurity,
  type AccountSsoPolicy,
  AppError,
  type LoginProvider,
  type SsoGate,
  ssoCovers,
  ssoOrgAllowed,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { AppDeps, SessionUser } from '../../types';
import { activeLoginProviders } from '../platform/login-providers';
import { activeMembershipsWithSettings } from './two-factor.repo';
import { securityOf } from './security.service';

/**
 * "Sign in through Google / Microsoft only" per account (Administration → אבטחה). Sessions are not
 * bound to an account (D12), so each account checks how the session it is opened with was made
 * (`auth_sessions.sign_in_method`): when the account requires a provider, a password or email-link session of a
 * covered person gets 403 `sso_required` there (and the app shows "sign in with …"), while it still opens their
 * other accounts. Not covered: the platform owner (always), admins when the account exempts them, people whose email
 * domain is outside the policy's list (when it has one), API tokens and service identities (not sign-ins).
 * Auto-join by domain is not part of it: sign-up stays invitation-only (auth.ts).
 *
 * S-72 (optional, recommended): the policy may also name the organisations a provider sign-in must come from —
 * Google Workspace domains (`hd`) and Microsoft directories (`tid`), kept with the session (`sign_in_org`). An empty
 * list accepts any account of that provider; with a list, a personal account (no `hd`, the consumer `tid`) or another
 * organisation's does not count, and the gate says so (`organization`).
 */
export const ssoApplies = (policy: AccountSsoPolicy, role: AccountRole, user: SessionUser) =>
  policy.required &&
  !user.isService &&
  !user.isPlatformOwner &&
  !(policy.exempt_admins && role === 'admin') &&
  ssoCovers(policy, user.email);

/** Signed in through one of the policy's providers (any organisation). */
const providerAccepted = (policy: AccountSsoPolicy, user: Pick<SessionUser, 'signInMethod'>) =>
  !!user.signInMethod && (policy.providers as string[]).includes(user.signInMethod);

export const ssoSatisfied = (policy: AccountSsoPolicy, user: Pick<SessionUser, 'signInMethod' | 'signInOrg'>) =>
  providerAccepted(policy, user) && ssoOrgAllowed(policy, user.signInMethod, user.signInOrg);

/** The gate of one account for this session, or null when it opens. */
const gateOf = (policy: AccountSsoPolicy, role: AccountRole, user: SessionUser) => {
  if (!ssoApplies(policy, role, user) || ssoSatisfied(policy, user)) return null;
  return {
    providers: policy.providers,
    // The right provider, the wrong organisation: the app asks for the organisation's account, not another door.
    ...(providerAccepted(policy, user) ? { organization: true } : {}),
  };
};

export const assertSsoGate = (security: AccountSecurity, role: AccountRole, user: SessionUser) => {
  const gate = gateOf(security.sso, role, user);
  if (gate) throw new AppError('forbidden', 'sso_required', gate);
};

/** GET /auth/me: my accounts that will not open with this session, and the providers each accepts. */
export const mySsoGates = async (db: Db, user: SessionUser): Promise<SsoGate[]> => {
  const gates: SsoGate[] = [];
  for (const m of await activeMembershipsWithSettings(db, user.id)) {
    const gate = gateOf(securityOf(m.settings ?? {}).sso, m.role as AccountRole, user);
    if (gate) gates.push({ account_id: m.accountId, ...gate });
  }
  return gates;
};

/**
 * Saving the policy (security.service.ts): it needs a provider the platform offers, and it may not shut out the admin
 * saving it — they must be exempt or be signed in through one of the chosen providers right now (and, S-72, from an
 * organisation the lists accept).
 */
export const assertSsoPolicySavable = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  policy: AccountSsoPolicy,
  role: AccountRole,
  user: SessionUser,
) => {
  if (!policy.required) return;
  if (!policy.providers.length) throw new AppError('invalid_value', 'sso_no_provider');
  const active = await activeLoginProviders(deps);
  const offered = policy.providers.filter((p: LoginProvider) => active[p]);
  if (!offered.length) throw new AppError('invalid_value', 'sso_provider_unavailable', { providers: policy.providers });
  if (ssoApplies(policy, role, user) && !ssoSatisfied(policy, user))
    throw new AppError('invalid_value', providerAccepted(policy, user) ? 'sso_org_excludes_you' : 'sso_excludes_you', {
      providers: policy.providers,
    });
};
