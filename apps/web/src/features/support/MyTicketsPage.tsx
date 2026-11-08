// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { formatDateTime, type MyAccount, t } from '@bines/shared';
import { Badge, Button, EmptyState, Notice, SkeletonRows, Tabs } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { NewTicketDialog } from './NewTicketDialog';
import { priorityLabel, statusLabel, statusTone, useMyTickets, useTicketOptions } from './support-api';

/**
 * "My tickets" (/a/:slug/support): the tickets I opened — admins (and members, by the account's
 * setting) see the account's — open or done, newest first; "new ticket" opens the same form as the "?" menu.
 */
export const MyTicketsPage = ({ account }: { account: MyAccount }) => {
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const list = useMyTickets(account.id, tab);
  const options = useTicketOptions(account.id);
  const [creating, setCreating] = useState(false);
  const rows = list.data?.data ?? [];
  return (
    <main className="w-full px-4 py-5 md:px-6" data-testid="my-tickets">
      <div className="mx-auto max-w-4xl space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h1 className="font-display text-[1.625rem] leading-tight font-extrabold text-heading">
              {t('tickets.mine.title')}
            </h1>
            <p className="text-sm text-muted">{t('tickets.mine.subtitle')}</p>
          </div>
          {options.data?.may_open ? (
            <Button variant="accent" onClick={() => setCreating(true)} data-testid="ticket-new">
              <Icon name="plus" size={14} />
              {t('tickets.menu.open')}
            </Button>
          ) : null}
        </header>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'open', label: t('tickets.mine.open'), testId: 'tickets-tab-open' },
            { value: 'done', label: t('tickets.mine.done'), testId: 'tickets-tab-done' },
          ]}
        />
        {list.isPending ? <SkeletonRows rows={4} label={t('app.loading')} /> : null}
        {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
        {list.data && !rows.length ? (
          <EmptyState icon={<Icon name="chat" size={28} />} title={t('tickets.mine.empty')} />
        ) : null}
        <ul className="overflow-hidden rounded-[14px] border border-line bg-surface">
          {rows.map((r) => (
            <li key={r.id} className="border-b border-line-soft last:border-b-0">
              <Link
                to={'/a/$accountSlug/support/$ticketId' as never}
                params={{ accountSlug: account.slug, ticketId: r.id } as never}
                data-testid="ticket-row"
                data-number={r.number}
                data-status={r.status}
                className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-surface-2"
              >
                <span className="font-mono text-xs text-muted tabular-nums" dir="ltr">
                  #{r.number}
                </span>
                <span className="min-w-0 flex-1 truncate font-normal text-fg" dir="auto">
                  {r.subject}
                </span>
                <span className="text-xs text-muted">{priorityLabel(r.priority)}</span>
                <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                <span className="text-xs text-muted" title={formatDateTime(r.created_at)}>
                  {formatDateTime(r.updated_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
      {creating ? <NewTicketDialog account={account} onClose={() => setCreating(false)} /> : null}
    </main>
  );
};
