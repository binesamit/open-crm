// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from '@tanstack/react-router';
import { t } from '@bines/shared';
import { cn } from '@bines/ui';
import type { MyAccount } from '../../lib/api';

/** The "N trial days left" pill: the account is on a trial (admins get "upgrade" → My plan). */
export const daysLeft = (iso: string, now = Date.now()) => Math.max(0, Math.ceil((Date.parse(iso) - now) / 86_400_000));

export const TrialPill = ({ account, className }: { account: MyAccount; className?: string }) => {
  if (account.plan_status !== 'trial' || !account.trial_ends_at) return null;
  const n = daysLeft(account.trial_ends_at);
  return (
    <span
      data-testid="trial-pill"
      className={cn(
        'inline-flex h-[1.875rem] max-w-full items-center gap-2 rounded-full bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] px-3 text-[0.78125rem] text-shell-strong',
        className,
      )}
    >
      <span className="truncate">{n === 1 ? t('trial.pill.one') : t('trial.pill', { n })}</span>
      {account.role === 'admin' ? (
        <Link
          to="/a/$accountSlug/admin/$section"
          params={{ accountSlug: account.slug, section: 'plan' }}
          className="shrink-0 underline underline-offset-2 hover:no-underline"
          data-testid="trial-pill-upgrade"
        >
          {t('trial.upgrade')}
        </Link>
      ) : null}
    </span>
  );
};
