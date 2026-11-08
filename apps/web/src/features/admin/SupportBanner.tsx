// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { formatDateTime, type MyAccount, t } from '@bines/shared';
import { cn } from '@bines/ui';
import { Icon } from '../../lib/icons';

/** "3 שעות ו-12 דקות" / "12 דקות" — what is left of a support grant. */
export const timeLeft = (ms: number) => {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h >= 48) return t('support.left.days', { n: Math.floor(h / 24) });
  if (h && m) return t('support.left.hoursMinutes', { h, m });
  if (h) return t('support.left.hours', { h });
  return t('support.left.minutes', { m });
};

/**
 * The remote-support banner: above every page of an account opened by a support grant
 * (`account.support` from /me/accounts or /auth/me), never closable — the mode, the time left (every minute) and the
 * end time. Amber for view, red for edit. When the grant ends, the next request is refused and the app leaves.
 * Mount: in the account layout next to <AnnouncementBanner> — `<SupportBanner account={account} />`.
 */
export const SupportBanner = ({ account }: { account: MyAccount }) => {
  const support = account.support;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!support) return;
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [support]);
  if (!support) return null;
  const left = Date.parse(support.expires_at) - now;
  const edit = support.mode === 'edit';
  return (
    <div
      role="status"
      data-testid="support-banner"
      data-mode={support.mode}
      className={cn(
        'flex shrink-0 items-center gap-2.5 border-b px-4 py-2 text-sm font-semibold max-md:px-3',
        edit ? 'border-danger bg-danger-soft text-danger-fg' : 'border-warn bg-warn-soft text-fg',
      )}
    >
      <Icon name="lock" size={16} className="shrink-0" />
      <p className="min-w-0 flex-1 break-words">
        {t(edit ? 'support.banner.edit' : 'support.banner.view', { account: account.name })}{' '}
        {/* Approved from a support ticket: its number. */}
        {support.ticket_number ? (
          <span data-testid="support-banner-ticket">
            {t('tickets.banner.ticket', { number: support.ticket_number })}{' '}
          </span>
        ) : null}
        <span className="font-normal" data-testid="support-banner-left" title={formatDateTime(support.expires_at)}>
          {left > 0 ? t('support.banner.left', { left: timeLeft(left) }) : t('support.banner.ended')}
        </span>
      </p>
    </div>
  );
};
