// SPDX-License-Identifier: AGPL-3.0-only
import { type AccountAction, AppError, canAccount } from '@bines/shared';
import type { AccountContext } from '../types';

/** The account-level actions only an admin may do (`canAccount`, 05 §2). */
export type AccountAdminAction = Extract<
  AccountAction,
  'account.update' | 'users.manage' | 'invitations.manage' | 'audit.read'
>;

/**
 * "Is this request an account admin?" — THE check every admin-only service uses, by the central `canAccount`
 * (packages/shared/permissions). The role is the request's account role:
 * - remote support access acts as an admin (its grant gives the admin role); what it may not do (view mode,
 *   people, tokens, security, support access) is the support middleware's (`assertSupportRequest`), and a service
 *   that refuses support even in edit mode checks `ctx.support` itself;
 * - the platform owner bypasses nothing inside an account (CLAUDE.md §7): only an admin membership (or a support
 *   grant) makes him an admin here.
 */
export const isAccountAdmin = (ctx: Pick<AccountContext, 'role'>, action: AccountAdminAction = 'account.update') =>
  canAccount(ctx.role, action).ok;

/**
 * Throws `forbidden` unless the request is an account admin (`isAccountAdmin`). `reason` = the error's reason the
 * module's clients already know (default: `canAccount`'s, `admin_only`).
 */
export const assertAccountAdmin = (
  ctx: Pick<AccountContext, 'role'>,
  opts: { action?: AccountAdminAction; reason?: string } = {},
) => {
  const decision = canAccount(ctx.role, opts.action ?? 'account.update');
  if (!decision.ok) throw new AppError('forbidden', opts.reason ?? decision.reason);
};
