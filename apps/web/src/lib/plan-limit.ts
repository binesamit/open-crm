// SPDX-License-Identifier: AGPL-3.0-only
import { MutationCache, type QueryClient } from '@tanstack/react-query';
import { ApiError } from '@bines/sdk';
import type { MenuEntry } from '@bines/ui';
import {
  t,
  featureAllowed,
  type MyAccount,
  type PlanFeatureDetails,
  type PlanFeatureKey,
  type PlanLimitDetails,
  statusBlocksAi,
} from '@bines/shared';
import { errorMessage, queryKeys } from './api';
import { showToast } from './toast';

/**
 * Plans: a 402 `plan_limit_reached` becomes a friendly toast ("You reached the plan's 10 users") with
 * an upgrade link to Administration → My plan for the account's admins. Nothing else changes on screen: the action
 * did not happen, nothing was deleted or hidden.
 */
export const planLimitOf = (err: unknown): PlanLimitDetails | null =>
  err instanceof ApiError && err.body.code === 'plan_limit_reached'
    ? ((err.body.details ?? null) as PlanLimitDetails | null)
    : null;

/** Plans: a 402 `plan_feature_unavailable` (the plan lacks a feature) — the same toast. */
export const planFeatureOf = (err: unknown): PlanFeatureDetails | null =>
  err instanceof ApiError && err.body.code === 'plan_feature_unavailable'
    ? ((err.body.details ?? null) as PlanFeatureDetails | null)
    : null;

/**
 * Does the account's plan include this feature (`plan_features` on /me/accounts; null / missing = everything)?
 * An enterprise feature also opens with the installation's license key (`license_features`, `featureAllowed`).
 * The app hides or disables a gated action with it and shows the upgrade hint; the server enforces regardless.
 */
export const hasPlanFeature = (
  account: Pick<MyAccount, 'plan_features' | 'license_features'> | null | undefined,
  key: PlanFeatureKey,
) => featureAllowed(account?.plan_features ?? null, account?.license_features ?? [], key);

/**
 * A gated control's state: may it be used, and may this person upgrade (admins of the account). `reason`: why not —
 * the plan lacks the feature (default), or the account's plan status stops it (`status`: AI in a read-only,
 * suspended or closed account — plan-lock).
 */
export type PlanGate = {
  key: PlanFeatureKey;
  allowed: boolean;
  admin: boolean;
  slug: string | null;
  reason?: 'feature' | 'status';
};

export const planGateOf = (
  account: Pick<MyAccount, 'plan_features' | 'license_features' | 'role' | 'slug' | 'plan_status'> | null | undefined,
  key: PlanFeatureKey,
): PlanGate => {
  // plan-lock (product decision): no AI at all while the account is read-only, suspended or closed — not even opening it.
  const statusOff = key === 'ai' && statusBlocksAi(account?.plan_status);
  const featureOn = hasPlanFeature(account, key);
  return {
    key,
    allowed: !statusOff && featureOn,
    admin: account?.role === 'admin',
    slug: account?.slug ?? null,
    ...(statusOff ? { reason: 'status' as const } : !featureOn ? { reason: 'feature' as const } : {}),
  };
};

/** The hint a gated control shows: the plan status's (AI off in this status) or the upgrade hint. */
export const planGateHint = (gate: Pick<PlanGate, 'reason'>) =>
  gate.reason === 'status' ? t('plan.ai.blocked') : planUpgradeHint();

/**
 * The attributes of a gated control: still visible and focusable, `aria-disabled` with the upgrade hint as its
 * tooltip (`data-tip`, never a native one). Its click handler must check `gate.allowed` itself.
 */
export const planGateAttrs = (gate: PlanGate) =>
  gate.allowed
    ? {}
    : {
        'aria-disabled': true as const,
        'data-tip': planGateHint(gate),
        'data-plan-gated': gate.key,
        className: 'cursor-not-allowed opacity-45',
      };

/** The upgrade hint shown on every gated control (tooltip, banner, note). */
export const planUpgradeHint = () => t('plan.feature.upgradeHint');

/**
 * A menu row under a gate: still listed, but disabled with the upgrade hint as its tooltip; the row gets the test id
 * `menu-<id>` (or keeps its own). Separators, labels and submenus pass through.
 */
export const gateMenuEntry = (gate: PlanGate | undefined, entry: MenuEntry, id?: string): MenuEntry => {
  if (!gate || (entry.kind && entry.kind !== 'item')) return entry;
  const testId = entry.testId ?? (id ? `menu-${id}` : undefined);
  return gate.allowed
    ? { ...entry, testId }
    : { ...entry, testId, disabled: true, hint: planGateHint(gate), onSelect: () => undefined };
};

/**
 * "Upgrade" at the end of a menu that has gated rows: one row, for the account's admins only (members see just the
 * hint on the disabled rows). `go` navigates (the router's).
 */
export const planUpgradeMenuEntries = (gates: (PlanGate | undefined)[], go: (path: string) => void): MenuEntry[] => {
  const g = gates.find((x) => x && !x.allowed && x.admin && x.slug);
  if (!g?.slug) return [];
  const slug = g.slug;
  return [
    { kind: 'separator' },
    { label: t('plan.upgrade'), testId: `plan-upgrade-${g.key}`, onSelect: () => go(myPlanPath(slug)) },
  ];
};

/** The account in the URL (`/a/<slug>/…`) as the switcher knows it (role included). */
const accountInUrl = (qc: QueryClient): MyAccount | undefined => {
  const slug = /^\/a\/([^/]+)/.exec(window.location.pathname)?.[1];
  if (!slug) return undefined;
  // The cache holds the /me/accounts response ({ data: [...] }), not the bare list.
  return qc
    .getQueryData<{ data: MyAccount[] }>(queryKeys.myAccounts)
    ?.data.find((a) => a.slug === decodeURIComponent(slug));
};

/** "My plan" of an account (admins). */
export const myPlanPath = (slug: string) => `/a/${slug}/admin/plan`;

/** The toast for a plan limit: the message, and "upgrade" for admins (members are told to ask an admin). */
export const showPlanLimitToast = (
  err: unknown,
  account: Pick<MyAccount, 'slug' | 'role'> | undefined,
  go: (path: string) => void,
) => {
  const admin = account?.role === 'admin';
  const message = admin ? errorMessage(err) : `${errorMessage(err)} ${t('plan.limit.askAdmin')}`;
  showToast({
    message,
    tone: 'error',
    seconds: 8,
    ...(admin && account ? { action: { label: t('plan.upgrade'), run: () => go(myPlanPath(account.slug)) } } : {}),
  });
};

/**
 * Every mutation that fails on a plan limit shows the plan toast first (the cache's handler runs before the
 * mutation's own; `showToast` drops the same message shown again right after).
 */
export const planLimitMutationCache = (getClient: () => QueryClient, go: (path: string) => void) =>
  new MutationCache({
    onError: (err) => {
      if (planLimitOf(err) || planFeatureOf(err)) showPlanLimitToast(err, accountInUrl(getClient()), go);
    },
  });
