// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { formatNumber, type MyAccount, t, type Usage } from '@bines/shared';
import { Badge, cn, EmptyState, formatIsoDate, Notice, Segmented, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { Ago, TD, TH, TR } from '../trash/TrashPage';
import { useUsage } from './admin-a45-api';
import { formatBytes, Panel, SectionHeader, StatCard } from './admin-parts';

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

const num = (n: number) => formatNumber(n);

/**
 * Administration → שימוש (08 §8, account admin A5): what the account used in the last 7 / 30 / 90 days — automation
 * runs and failures, webhook deliveries, tokens, storage, items and active people — a daily chart of runs, the busiest
 * automations and the tokens used last. Computed from the tables on every visit (no rollup job yet).
 */
export const AdminUsage = ({ account }: { account: MyAccount }) => {
  const [days, setDays] = useState<Period>(30);
  const usage = useUsage(account.id, days);
  const u = usage.data;
  return (
    <div className="flex flex-col gap-4 pb-12" data-testid="admin-usage">
      <SectionHeader
        title={t('admin.section.usage')}
        subtitle={t('a45.usage.subtitle')}
        actions={
          <Segmented<`${Period}`>
            label={t('a45.usage.period')}
            value={`${days}`}
            onChange={(v) => setDays(Number(v) as Period)}
            testId="usage-period"
            options={PERIODS.map((p) => ({
              value: `${p}` as `${Period}`,
              label: t('a45.usage.days', { n: p }),
              testId: `usage-period-${p}`,
            }))}
          />
        }
      />
      {usage.isPending ? <SkeletonRows rows={4} label={t('app.loading')} /> : null}
      {usage.isError ? <Notice tone="error">{errorMessage(usage.error)}</Notice> : null}
      {u ? <UsageBody account={account} u={u} /> : null}
    </div>
  );
};

const UsageBody = ({ account, u }: { account: MyAccount; u: Usage }) => {
  const [now] = useState(() => Date.now());
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="usage-cards">
        <StatCard
          testId="usage-automation-runs"
          label={t('a45.usage.automationRuns')}
          value={num(u.automation_runs)}
          sub={t('a45.usage.failures', { n: num(u.automation_failures) })}
          tone={u.automation_failures > 0 && u.automation_failures * 10 > u.automation_runs ? 'danger' : undefined}
        />
        <StatCard
          testId="usage-webhooks"
          label={t('a45.usage.webhooks')}
          value={num(u.webhook_deliveries)}
          sub={t('a45.usage.failures', { n: num(u.webhook_failures) })}
        />
        <StatCard
          testId="usage-api"
          label={t('a45.usage.api')}
          value={u.api_calls === null ? '—' : num(u.api_calls)}
          sub={t('a45.usage.tokensUsed', { n: num(u.tokens_used) })}
        />
        <StatCard
          testId="usage-active-users"
          label={t('a45.usage.activeUsers')}
          value={num(u.active_users)}
          sub={t('a45.usage.ofMembers', { n: num(u.members_total) })}
        />
        <StatCard
          testId="usage-storage"
          label={t('a45.usage.storage')}
          value={<bdi dir="ltr">{formatBytes(u.storage_bytes)}</bdi>}
          sub={t('a45.usage.files', { n: num(u.files) })}
        />
        <StatCard testId="usage-items" label={t('a45.usage.items')} value={num(u.items_total)} />
        <StatCard testId="usage-boards" label={t('a45.usage.boards')} value={num(u.boards_total)} />
      </div>

      <Panel title={t('a45.usage.chart')} hint={t('a45.usage.chartHint')} testId="usage-chart">
        <DailyBars u={u} />
      </Panel>

      <Panel title={t('a45.usage.topAutomations')} testId="usage-top-automations">
        {u.top_automations.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className={TH}>{t('a45.usage.col.automation')}</th>
                  <th className={TH}>{t('a45.usage.col.board')}</th>
                  <th className={TH}>{t('a45.usage.col.runs')}</th>
                  <th className={TH}>{t('a45.usage.col.failures')}</th>
                  <th className={TH}>{t('a45.usage.col.lastRun')}</th>
                </tr>
              </thead>
              <tbody>
                {u.top_automations.map((a) => (
                  <tr key={a.id} className={cn(TR, 'hover:bg-row-alt')} data-testid="usage-automation-row">
                    <td className={cn(TD, 'max-w-[260px] truncate font-semibold text-fg')}>
                      {a.title}
                      {!a.is_active ? (
                        <span className="ms-1.5">
                          <Badge>{t('a45.usage.off')}</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td className={cn(TD, 'max-w-[200px] truncate text-fg-2')}>
                      {a.board_id ? (
                        <Link
                          to="/a/$accountSlug/b/$boardId"
                          params={{ accountSlug: account.slug, boardId: a.board_id }}
                          className="hover:underline"
                        >
                          {a.board_name}
                        </Link>
                      ) : (
                        t('a45.usage.accountLevel')
                      )}
                    </td>
                    <td className={cn(TD, 'tabular-nums')}>{num(a.runs)}</td>
                    <td className={cn(TD, 'tabular-nums', a.failures > 0 && 'text-danger-fg')}>{num(a.failures)}</td>
                    <td className={cn(TD, 'text-fg-2')}>
                      {a.last_run_at ? <Ago iso={a.last_run_at} now={now} /> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title={t('a45.usage.noRuns')} testId="usage-no-runs" />
        )}
      </Panel>

      <Panel title={t('a45.usage.topTokens')} hint={t('a45.usage.topTokensHint')} testId="usage-top-tokens">
        {u.top_tokens.length ? (
          <ul>
            {u.top_tokens.map((tk) => (
              <li
                key={tk.id}
                data-testid="usage-token-row"
                className="flex items-center gap-3 border-b border-line-soft px-3.5 py-2.5 last:border-b-0"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold text-fg">{tk.name}</span>
                  <span className="truncate text-[0.6875rem] text-muted">
                    <bdi dir="ltr">{tk.prefix}…</bdi> · {tk.user_name ?? '—'}
                  </span>
                </span>
                {tk.service ? <Badge tone="violet">{t('a45.usage.service')}</Badge> : null}
                <span className="shrink-0 text-xs text-fg-2">
                  {tk.last_used_at ? <Ago iso={tk.last_used_at} now={now} /> : '—'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={t('a45.usage.noTokens')} testId="usage-no-tokens" />
        )}
      </Panel>
    </>
  );
};

/** One bar per day: automation runs (the bar) — the exact numbers in each bar's title. */
const DailyBars = ({ u }: { u: Usage }) => {
  const max = Math.max(1, ...u.daily.map((d) => d.automation_runs));
  const first = u.daily[0]?.day;
  const last = u.daily.at(-1)?.day;
  return (
    <div className="px-3.5 py-3">
      <div
        className="flex h-28 items-end gap-[0.125rem]"
        role="img"
        aria-label={t('a45.usage.chart')}
        data-testid="usage-bars"
      >
        {u.daily.map((d) => (
          <div
            key={d.day}
            title={`${formatIsoDate(d.day)}: ${t('a45.usage.barTitle', {
              runs: d.automation_runs,
              hooks: d.webhook_deliveries,
            })}`}
            className="flex h-full min-w-0 flex-1 items-end"
          >
            <div
              className={cn('w-full rounded-t-[3px]', d.automation_runs ? 'bg-primary' : 'bg-line-soft')}
              style={{ height: `${Math.max(3, (d.automation_runs / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[0.6875rem] text-muted">
        <span>{first ? formatIsoDate(first) : null}</span>
        <span>{last ? formatIsoDate(last) : null}</span>
      </div>
    </div>
  );
};
