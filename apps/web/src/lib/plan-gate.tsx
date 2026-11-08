// SPDX-License-Identifier: AGPL-3.0-only
import { forwardRef, type ComponentProps, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { t, type PlanFeatureKey } from '@bines/shared';
import { Button, cn } from '@bines/ui';
import { api, type MyAccount, queryKeys } from './api';
import { planGateHint, planGateOf, type PlanGate } from './plan-limit';

/**
 * Plan feature gates in the UI: the account as `/me/accounts` holds it now (it refetches when the
 * plan changes), and whether its plan includes `key`. A gated control stays visible but disabled with the upgrade
 * hint (`planGateAttrs`); admins also get `PlanUpgradeLink`. Nothing existing is hidden; the server enforces anyway.
 */
export const usePlanGate = (accountId: string, key: PlanFeatureKey): PlanGate => usePlanGates(accountId)(key);

/** Every gate of an account from one hook: `const gate = usePlanGates(id); gate('ai').allowed`. */
export const usePlanGates = (accountId: string | null | undefined) => {
  const accounts = useQuery({
    queryKey: queryKeys.myAccounts,
    queryFn: () => api().get<{ data: MyAccount[] }>('/me/accounts'),
    staleTime: 60_000,
  });
  const account = accountId ? accounts.data?.data?.find((a) => a.id === accountId) : undefined;
  return (key: PlanFeatureKey): PlanGate => planGateOf(account, key);
};

/** "Upgrade" to the account's plan page — for admins, only while the feature is gated. */
export const PlanUpgradeLink = ({ gate, className }: { gate: PlanGate; className?: string }) =>
  gate.allowed || !gate.admin || !gate.slug ? null : (
    <Link
      to="/a/$accountSlug/admin/$section"
      params={{ accountSlug: gate.slug, section: 'plan' }}
      data-testid={`plan-upgrade-${gate.key}`}
      className={
        className ?? 'text-xs font-semibold whitespace-nowrap text-primary hover:underline focus-visible:underline'
      }
    >
      {t('plan.upgrade')}
    </Link>
  );

/** The hint line (and "Upgrade" for admins) shown next to a gated form control. */
export const PlanGateNote = ({ gate }: { gate: PlanGate }) =>
  gate.allowed ? null : (
    <p className="flex flex-wrap items-center gap-2 text-xs text-muted" data-testid={`plan-gate-note-${gate.key}`}>
      <span>{planGateHint(gate)}</span>
      <PlanUpgradeLink gate={gate} />
    </p>
  );

/**
 * A `Button` under a plan gate: when the plan lacks the feature it stays visible and focusable, `aria-disabled` with
 * the upgrade hint as its tooltip, and its click does nothing; admins get "Upgrade" next to it (`upgrade={false}`
 * where there is no room, e.g. a toolbar icon).
 */
export const GatedButton = forwardRef<
  HTMLButtonElement,
  ComponentProps<typeof Button> & { gate: PlanGate; upgrade?: boolean }
>(({ gate, upgrade = true, onClick, className, title, ...props }, ref) => {
  if (gate.allowed) return <Button ref={ref} onClick={onClick} className={className} title={title} {...props} />;
  // No `title` while gated: the tooltip system would move it over the upgrade hint.
  const button = (
    <Button
      ref={ref}
      {...props}
      aria-disabled
      data-tip={planGateHint(gate)}
      data-plan-gated={gate.key}
      className={cn(className, 'cursor-not-allowed opacity-45')}
      onClick={(e: MouseEvent<HTMLButtonElement>) => e.preventDefault()}
    />
  );
  return upgrade && gate.admin ? (
    <span className="inline-flex items-center gap-2">
      {button}
      <PlanUpgradeLink gate={gate} />
    </span>
  ) : (
    button
  );
});
GatedButton.displayName = 'GatedButton';

/** A thin banner over a page the plan made read-only (dashboards, docs): the hint, and "Upgrade" for admins. */
export const PlanGateBanner = ({ gate }: { gate: PlanGate }) =>
  gate.allowed ? null : (
    <div
      role="status"
      data-testid={`plan-gate-banner-${gate.key}`}
      className="flex flex-wrap items-center gap-2 border-b border-warn bg-warn-soft px-4 py-2 text-xs text-fg"
    >
      <span>{planGateHint(gate)}</span>
      <PlanUpgradeLink gate={gate} />
    </div>
  );
