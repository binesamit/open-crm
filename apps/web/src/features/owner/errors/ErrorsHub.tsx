// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ERROR_SEVERITIES,
  ERROR_SOURCES,
  ERROR_STATUSES,
  type ErrorEvent,
  type ErrorHubConfig,
  formatDateTime,
  t,
} from '@bines/shared';
import { Badge, Button, Card, cn, EmptyState, Input, Notice, Picker, Segmented, SkeletonRows, Tabs } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { ErrorCount } from './ErrorCount';
import { ErrorDetailPanel } from './ErrorDetail';
import { ErrorSettings } from './ErrorSettings';
import {
  errorKeys,
  severityLabel,
  severityTone,
  sourceLabel,
  statusLabel,
  statusTone,
  useErrorAccounts,
  useErrorAlerts,
  useErrorConfig,
  useErrorList,
} from './errors-api';

type Tab = 'errors' | 'accounts' | 'alerts' | 'settings';
type View = 'all' | 'recurring' | 'spikes';
const OPEN = 'new,acknowledged';

/**
 * Owner console → "Errors & health": every account's errors in one place — filters, the views
 * "recurring" and "spikes", errors by account, the alerts sent to me, and the settings (leads and the owner). An
 * error opens on the side: metadata, status, assignee, tickets; the account's data only with a support grant.
 */
export const ErrorsHub = ({ initial }: { initial?: string }) => {
  const config = useErrorConfig();
  const alerts = useErrorAlerts();
  const [tab, setTab] = useState<Tab>('errors');
  const [accountFilter, setAccountFilter] = useState('');
  if (config.isPending) return <SkeletonRows rows={6} label={t('app.loading')} />;
  if (config.isError) return <Notice tone="error">{errorMessage(config.error)}</Notice>;
  const c = config.data;
  const unread = alerts.data?.unread ?? 0;
  const tabs: { value: Tab; label: React.ReactNode; testId: string }[] = [
    { value: 'errors', label: t('errors.tab.errors'), testId: 'errors-tab-errors' },
    { value: 'accounts', label: t('errors.tab.accounts'), testId: 'errors-tab-accounts' },
    {
      value: 'alerts',
      label: (
        <span className="inline-flex items-center gap-1.5">
          {t('errors.tab.alerts')}
          <ErrorCount n={unread} testId="errors-alerts-unread" />
        </span>
      ),
      testId: 'errors-tab-alerts',
    },
    { value: 'settings', label: t('errors.tab.settings'), testId: 'errors-tab-settings' },
  ];
  return (
    <section className="space-y-3" data-testid="errors-hub" data-role={c.role}>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {c.dropped ? <Notice tone="warn">{t('errors.dropped', { n: c.dropped })}</Notice> : null}
      {tab === 'errors' ? (
        <ErrorsTab config={c} initial={initial} account={accountFilter} onAccount={setAccountFilter} />
      ) : null}
      {tab === 'accounts' ? (
        <AccountsTab
          onOpen={(id) => {
            setAccountFilter(id);
            setTab('errors');
          }}
        />
      ) : null}
      {tab === 'alerts' ? <AlertsTab /> : null}
      {tab === 'settings' ? <ErrorSettings config={c} /> : null}
    </section>
  );
};

const ErrorsTab = ({
  config,
  initial,
  account,
  onAccount,
}: {
  config: ErrorHubConfig;
  initial?: string;
  account: string;
  onAccount: (id: string) => void;
}) => {
  const [view, setView] = useState<View>('all');
  const [filters, setFilters] = useState<Record<string, string>>({ status: OPEN });
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(initial ?? null);
  const list = useErrorList({ ...filters, account_id: account, q, view });
  const set = (k: string) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const rows = list.data?.data ?? [];
  const all = { value: '', label: t('errors.filter.all') };
  return (
    <div className="flex items-start gap-4 max-lg:flex-col">
      <div className={cn('min-w-0 space-y-2', selected ? 'flex-[1_1_440px] max-lg:w-full' : 'w-full')}>
        <div className="flex flex-wrap items-center gap-2" data-testid="errors-filters">
          <Segmented
            label={t('errors.view')}
            value={view}
            onChange={setView}
            testId="errors-view"
            options={[
              { value: 'all', label: t('errors.view.all'), testId: 'errors-view-all' },
              { value: 'recurring', label: t('errors.view.recurring'), testId: 'errors-view-recurring' },
              { value: 'spikes', label: t('errors.view.spikes'), testId: 'errors-view-spikes' },
            ]}
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('errors.filter.search')}
            className="w-44"
            data-testid="errors-search"
          />
          <Picker
            label={t('errors.field.source')}
            className="w-36"
            value={filters.source ?? ''}
            onChange={set('source')}
            testId="errors-filter-source"
            options={[all, ...ERROR_SOURCES.map((s) => ({ value: s, label: sourceLabel(s), testId: `source-${s}` }))]}
          />
          <Picker
            label={t('errors.field.severity')}
            className="w-32"
            value={filters.severity ?? ''}
            onChange={set('severity')}
            testId="errors-filter-severity"
            options={[all, ...ERROR_SEVERITIES.map((s) => ({ value: s, label: severityLabel(s) }))]}
          />
          <Picker
            label={t('errors.field.status')}
            className="w-36"
            value={filters.status ?? ''}
            onChange={set('status')}
            testId="errors-filter-status"
            options={[
              all,
              { value: OPEN, label: t('errors.filter.open') },
              ...ERROR_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
            ]}
          />
          <Picker
            label={t('errors.field.account')}
            className="w-40"
            value={account}
            onChange={onAccount}
            testId="errors-filter-account"
            options={[all, ...config.accounts.map((a) => ({ value: a.id, label: a.name }))]}
          />
          <Picker
            label={t('errors.field.assignee')}
            className="w-36"
            value={filters.assignee ?? ''}
            onChange={set('assignee')}
            testId="errors-filter-assignee"
            options={[
              all,
              { value: 'me', label: t('errors.filter.me') },
              { value: 'none', label: t('errors.assignee.none') },
              ...config.agents.map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
        </div>
        {list.isPending ? <SkeletonRows rows={5} label={t('app.loading')} /> : null}
        {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
        {list.data && !rows.length ? (
          <EmptyState icon={<Icon name="check" size={28} />} title={t('errors.empty')} testId="errors-empty" />
        ) : null}
        {rows.length ? (
          <ul className="overflow-hidden rounded-[12px] border border-line bg-surface" data-testid="errors-list">
            {rows.map((r) => (
              <ErrorRow key={r.id} r={r} active={r.id === selected} onOpen={() => setSelected(r.id)} />
            ))}
          </ul>
        ) : null}
        {list.data && list.data.total > rows.length ? (
          <p className="text-xs text-muted">{t('errors.more', { n: list.data.total - rows.length })}</p>
        ) : null}
      </div>
      {selected ? (
        <Card className="min-w-0 flex-[1_1_520px] max-lg:w-full">
          <ErrorDetailPanel key={selected} id={selected} config={config} onClose={() => setSelected(null)} />
        </Card>
      ) : null}
    </div>
  );
};

const ErrorRow = ({ r, active, onOpen }: { r: ErrorEvent; active: boolean; onOpen: () => void }) => (
  <li className="border-b border-line-soft last:border-b-0">
    <button
      type="button"
      onClick={onOpen}
      data-testid="error-row"
      data-source={r.source}
      data-status={r.status}
      data-severity={r.severity}
      className={cn('flex w-full flex-col gap-1 px-3 py-2.5 text-start hover:bg-surface-2', active && 'bg-surface-2')}
    >
      <span className="flex w-full items-center gap-2">
        <Badge tone={severityTone(r.severity)}>{severityLabel(r.severity)}</Badge>
        <span className="text-xs font-semibold text-fg-2">{sourceLabel(r.source)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" dir="ltr">
          {r.code}
        </span>
        <span className="text-xs tabular-nums text-fg-2" title={t('errors.count')} data-testid="error-count">
          ×{r.count}
        </span>
      </span>
      <span className="w-full truncate text-sm text-fg" dir="auto">
        {r.message}
      </span>
      <span className="flex w-full flex-wrap items-center gap-2 text-xs text-muted">
        <span>{r.account?.name ?? t('errors.platform')}</span>
        <span>·</span>
        <span>{formatDateTime(r.last_seen_at)}</span>
        {r.last_hour ? <span className="text-danger-fg">{t('errors.lastHour', { n: r.last_hour })}</span> : null}
        <span className="ms-auto flex items-center gap-1.5">
          {r.assignee ? <span>{r.assignee.name}</span> : null}
          {r.ticket ? <span dir="ltr">#{r.ticket.number}</span> : null}
          <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
        </span>
      </span>
    </button>
  </li>
);

const AccountsTab = ({ onOpen }: { onOpen: (accountId: string) => void }) => {
  const q = useErrorAccounts();
  if (q.isPending) return <SkeletonRows rows={4} label={t('app.loading')} />;
  if (q.isError) return <Notice tone="error">{errorMessage(q.error)}</Notice>;
  const rows = q.data.data;
  if (!rows.length) return <EmptyState icon={<Icon name="check" size={28} />} title={t('errors.empty')} />;
  return (
    <ul className="overflow-hidden rounded-[12px] border border-line bg-surface" data-testid="errors-accounts">
      {rows.map((r) => (
        <li key={r.account?.id ?? 'platform'} className="border-b border-line-soft last:border-b-0">
          <button
            type="button"
            disabled={!r.account}
            onClick={() => r.account && onOpen(r.account.id)}
            data-testid="errors-account-row"
            data-account={r.account?.slug ?? ''}
            className="flex w-full items-center gap-3 px-3 py-2.5 text-start hover:bg-surface-2 disabled:cursor-default"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
              {r.account?.name ?? t('errors.platform')}
            </span>
            {r.critical ? <Badge tone="danger">{t('errors.accounts.critical', { n: r.critical })}</Badge> : null}
            <Badge tone={r.open ? 'warn' : 'ok'}>{t('errors.accounts.open', { n: r.open })}</Badge>
            <span className="text-xs text-muted tabular-nums">
              {t('errors.accounts.day', { n: r.occurrences_24h })}
            </span>
            <span className="text-xs text-muted">{r.last_seen_at ? formatDateTime(r.last_seen_at) : ''}</span>
          </button>
        </li>
      ))}
    </ul>
  );
};

const AlertsTab = () => {
  const q = useErrorAlerts();
  const qc = useQueryClient();
  const read = useMutation({
    mutationFn: () => api().post<{ data: unknown[]; unread: number }>('/platform/errors/alerts/read'),
    onSuccess: (res) => qc.setQueryData(errorKeys.alerts, res),
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  if (q.isPending) return <SkeletonRows rows={4} label={t('app.loading')} />;
  if (q.isError) return <Notice tone="error">{errorMessage(q.error)}</Notice>;
  const rows = q.data.data;
  return (
    <div className="space-y-2" data-testid="errors-alerts">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">{t('errors.alerts.hint')}</p>
        <Button
          variant="ghost"
          size="sm"
          disabled={!q.data.unread}
          busy={read.isPending}
          onClick={() => read.mutate()}
          data-testid="errors-alerts-read"
        >
          {t('errors.alerts.readAll')}
        </Button>
      </div>
      {!rows.length ? <EmptyState icon={<Icon name="bell" size={28} />} title={t('errors.alerts.empty')} /> : null}
      <ul className="overflow-hidden rounded-[12px] border border-line bg-surface">
        {rows.map((a) => (
          <li
            key={a.id}
            className={cn(
              'space-y-1 border-b border-line-soft px-3 py-2.5 last:border-b-0',
              !a.read && 'bg-accent-soft/40',
            )}
            data-testid="errors-alert"
            data-read={a.read ? 'true' : 'false'}
            data-mode={a.mode}
          >
            <div className="flex items-center gap-2 text-xs text-muted">
              <Icon name="bell" size={13} />
              <span className="font-semibold text-fg-2">{a.rule_name}</span>
              <span>· {t(`errors.alerts.mode.${a.mode}`)}</span>
              <span className="ms-auto">{formatDateTime(a.created_at)}</span>
            </div>
            {a.events.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-sm">
                <Badge tone={severityTone(e.severity)}>{severityLabel(e.severity)}</Badge>
                <span className="text-xs text-fg-2">{sourceLabel(e.source)}</span>
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {e.message}
                </span>
                <span className="text-xs text-muted">{e.account_name ?? t('errors.platform')}</span>
                <span className="text-xs tabular-nums">×{a.total || e.count}</span>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
};
