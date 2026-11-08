// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient, type Query } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { PLAN_LIVE_EVENTS, t, type MyAccount } from '@bines/shared';
import { Notice } from '@bines/ui';
import { api, queryKeys, type Me } from '../../lib/api';
import { useEventStream } from '../../lib/realtime';
import { Icon } from '../../lib/icons';
import { myPlanPath } from '../../lib/plan-limit';
import { TopBar } from './TopBar';
import { clearPlanBlock, markPlanBlock, planBlockOf, planBlockOfStatus, usePlanBlock } from './plan-status';
import { AccountClosedScreen, CLOSED_REFETCH_MS } from './AccountClosed';
import { AccountDeletionScreen } from './AccountDeletion';

/** The suspended screen and the read-only banner, from the store in `plan-status.ts`. */

/** A query of another account (`['account', <id>, …]`) never marks this one. */
const ofAccount = (q: Query, accountId: string) => q.queryKey[0] !== 'account' || q.queryKey[1] === accountId;

/** Watches the query and mutation caches for this account's first 423 plan answer. */
const usePlanStatusWatch = (accountId: string) => {
  const qc = useQueryClient();
  useEffect(() => {
    const seen = (err: unknown) => {
      const block = planBlockOf(err);
      if (block) markPlanBlock(accountId, block);
    };
    // Answers that came before the shell mounted (the account's first queries).
    for (const q of qc.getQueryCache().getAll())
      if (q.state.status === 'error' && ofAccount(q, accountId)) seen(q.state.error);
    const offQueries = qc.getQueryCache().subscribe((e) => {
      if (e.type === 'updated' && e.action.type === 'error' && ofAccount(e.query, accountId)) seen(e.action.error);
    });
    const offMutations = qc.getMutationCache().subscribe((e) => {
      if (e.type === 'updated' && e.action.type === 'error') seen(e.action.error);
    });
    return () => {
      offQueries();
      offMutations();
    };
  }, [qc, accountId]);
};

/**
 * The plan status the server states up front (`plan_status` on /me/accounts, sync-followups): it decides when present
 * — so the banner shows before any write is refused, and clears when the owner restores the plan; `account.plan_changed`
 * on /me/events refetches it live. Without it (older API) the first 423 answer decides, as before.
 */
const useAccountPlanBlock = (account: MyAccount) => {
  const qc = useQueryClient();
  const accounts = useQuery({
    queryKey: queryKeys.myAccounts,
    queryFn: () => api().get<{ data: MyAccount[] }>('/me/accounts'),
    staleTime: 60_000,
    // Closed (plan-lock): the live stream is refused too, so the list is asked again now and then — reopening
    // brings the app back without a reload.
    refetchInterval: (q) => {
      const a = q.state.data?.data.find((x) => x.id === account.id) ?? account;
      return a.plan_status === 'closed' || a.deletion_due_at ? CLOSED_REFETCH_MS : false;
    },
  });
  const current = accounts.data?.data.find((a) => a.id === account.id) ?? account;
  // a scheduled deletion wins over every plan status.
  const stated = current.deletion_due_at ? 'deletion' : planBlockOfStatus(current.plan_status);
  useEventStream(stated === 'closed' || stated === 'deletion' ? null : '/me/events', account.id, (e) => {
    if (PLAN_LIVE_EVENTS.has(e.type)) void qc.invalidateQueries({ queryKey: queryKeys.myAccounts });
  });
  useEffect(() => {
    if (stated === null) clearPlanBlock(account.id);
    else if (stated) markPlanBlock(account.id, stated);
  }, [stated, account.id]);
  const marked = usePlanBlock(account.id);
  // A 423 the stated status has not caught up with yet still shows (the server refused — it knows best).
  return stated === undefined ? marked : (stated ?? marked);
};

/**
 * plan-lock: a closed account shows only the closed screen — before the 2FA / SSO and legal-consent gates (nothing of
 * the account opens, so there is nothing to sign in harder for or to agree to). Live stream and caches are shared
 * with `PlanGate` below it.
 */
export const AccountClosedGate = ({ me, account, children }: { me: Me; account: MyAccount; children: ReactNode }) => {
  usePlanStatusWatch(account.id);
  const block = useAccountPlanBlock(account);
  if (block === 'deletion') return <AccountDeletionScreen me={me} account={account} />;
  if (block === 'closed') return <AccountClosedScreen me={me} account={account} />;
  return children;
};

/**
 * The account's pages while its plan allows them; a suspended account shows one full-page notice instead (like a
 * suspended account), with "החבילה שלי" for admins. "My plan" itself (`/admin/plan`) keeps working there — without
 * the sidebar, whose queries the server refuses.
 */
export const PlanGate = ({ me, account, children }: { me: Me; account: MyAccount; children: ReactNode }) => {
  usePlanStatusWatch(account.id);
  const block = useAccountPlanBlock(account);
  const path = useRouterState({ select: (s) => s.location.pathname });
  // plan-lock: a closed account renders nothing of itself — only the closed screen (the server refuses the rest).
  if (block === 'deletion') return <AccountDeletionScreen me={me} account={account} />;
  if (block === 'closed') return <AccountClosedScreen me={me} account={account} />;
  if (block !== 'suspended') return children;
  const admin = account.role === 'admin';
  const plan = myPlanPath(account.slug);
  const onPlan = admin && (path === plan || path.startsWith(`${plan}/`));
  return (
    <div className="flex h-dvh flex-col bg-shell" data-testid="plan-suspended" data-on-plan={onPlan || undefined}>
      <TopBar me={me} current={account} />
      <main className="flex min-h-0 flex-1 flex-col p-3 pt-0">
        {onPlan ? (
          <div className="app-panel min-h-0 flex-1 overflow-auto">
            <Outlet />
          </div>
        ) : (
          <div className="app-panel mx-auto w-full max-w-md space-y-4 p-6">
            <Notice tone="error">
              <span data-testid="plan-suspended-message">{t('error.plan_suspended')}</span>
            </Notice>
            {admin ? (
              <Link
                to="/a/$accountSlug/admin/$section"
                params={{ accountSlug: account.slug, section: 'plan' }}
                data-testid="plan-suspended-open"
                className="inline-flex h-9 items-center gap-2 rounded-[10px] bg-primary px-4 text-sm font-semibold text-on-primary hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
              >
                <Icon name="gear" size={15} />
                {t('admin.section.plan')}
              </Link>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
};

/**
 * The read-only banner: above every page of the account once the server answered a write with `plan_read_only` —
 * reads go on, nothing is hidden. Never closable (the state is the account's). Admins get "החבילה שלי".
 * Mount: in the account layout next to <SupportBanner> — `<PlanReadOnlyBanner account={account} />`.
 */
export const PlanReadOnlyBanner = ({ account }: { account: MyAccount }) => {
  const block = useAccountPlanBlock(account);
  if (block !== 'read_only') return null;
  return (
    <div
      role="status"
      data-testid="plan-read-only-banner"
      className="sticky top-0 z-20 flex shrink-0 items-center gap-2.5 border-b border-warn bg-warn-soft px-4 py-2 text-sm font-semibold text-fg max-md:px-3"
    >
      <Icon name="lock" size={16} className="shrink-0" />
      <p className="min-w-0 flex-1 break-words">{t('error.plan_read_only')}</p>
      {account.role === 'admin' ? (
        <Link
          to="/a/$accountSlug/admin/$section"
          params={{ accountSlug: account.slug, section: 'plan' }}
          data-testid="plan-read-only-open"
          className="shrink-0 underline underline-offset-2 hover:no-underline"
        >
          {t('admin.section.plan')}
        </Link>
      ) : null}
    </div>
  );
};
