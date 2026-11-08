// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type AccountHealth, formatDateTime, type MyAccount, t } from '@bines/shared';
import { Badge, Card, EmptyState, Notice, Segmented, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { severityLabel, severityTone, sourceLabel } from '../owner/errors/errors-api';
import { SectionHeader } from './admin-parts';

type State = 'open' | 'resolved' | 'all';

/** The account's Health data (admins). The page and the nav's count share the "open" query. */
export const useAccountHealth = (account: MyAccount, state: State = 'open') =>
  useQuery({
    queryKey: ['account-health', account.id, state],
    queryFn: () => api(account.id).get<AccountHealth>(`/account-health?state=${state}`),
    refetchInterval: 120_000,
  });

/** Administration's nav: how many of the account's errors are open (0 while the page is off or nothing is open). */
export const useOpenHealthCount = (account: MyAccount) => {
  const q = useAccountHealth(account);
  return q.data?.enabled ? q.data.open : 0;
};

/** Where an error of this account opens (its most specific link) — the same order as the server's. */
export const healthPath = (slug: string, links: Record<string, string>) => {
  const base = `/a/${slug}`;
  if (links.item_id) return `${base}/i/${links.item_id}`;
  if (links.agent_id) return `${base}/agents/${links.agent_id}`;
  if (links.flow_connection_id) return `${base}/flows`;
  if (links.board_id) return `${base}/b/${links.board_id}`;
  if (links.installation_id) return `${base}/admin/extensions`;
  if (links.ai_connection_id) return `${base}/admin/ai`;
  if (links.automation_id) return `${base}/automations`;
  return null;
};

/**
 * Administration → Health: the account's own errors — what failed, how often, open or resolved
 * with a link to where to fix it. Support's own fields (assignee, notes, tickets) never reach this page; which
 * sources it shows, and whether it is shown at all, is the platform owner's setting.
 */
export const AdminHealth = ({ account }: { account: MyAccount }) => {
  const [state, setState] = useState<State>('open');
  const navigate = useNavigate();
  const q = useAccountHealth(account, state);
  return (
    <div className="space-y-4" data-testid="admin-health">
      <SectionHeader title={t('errors.health.title')} subtitle={t('errors.health.subtitle')} />
      {q.isPending ? <SkeletonRows rows={4} label={t('app.loading')} /> : null}
      {q.isError ? <Notice tone="error">{errorMessage(q.error)}</Notice> : null}
      {q.data && !q.data.enabled ? <Notice tone="info">{t('errors.health.off')}</Notice> : null}
      {q.data?.enabled ? (
        <>
          <div className="flex flex-wrap gap-3">
            <Card className="min-w-40 space-y-0.5" data-testid="health-open">
              <span className="text-xs text-muted">{t('errors.health.open')}</span>
              <span className="block font-display text-2xl font-bold tabular-nums">{q.data.open}</span>
            </Card>
            <Card className="min-w-40 space-y-0.5" data-testid="health-day">
              <span className="text-xs text-muted">{t('errors.health.day')}</span>
              <span className="block font-display text-2xl font-bold tabular-nums">{q.data.occurrences_24h}</span>
            </Card>
          </div>
          <Segmented
            label={t('errors.health.state')}
            value={state}
            onChange={setState}
            testId="health-state"
            options={[
              { value: 'open', label: t('errors.health.stateOpen') },
              { value: 'resolved', label: t('errors.health.stateResolved') },
              { value: 'all', label: t('errors.filter.all') },
            ]}
          />
          {!q.data.data.length ? (
            <EmptyState icon={<Icon name="check" size={28} />} title={t('errors.health.empty')} testId="health-empty" />
          ) : (
            <ul className="overflow-hidden rounded-[12px] border border-line bg-surface">
              {q.data.data.map((e) => {
                const path = healthPath(account.slug, e.links);
                return (
                  <li
                    key={e.id}
                    className="flex flex-col gap-1 border-b border-line-soft px-3 py-2.5 last:border-b-0"
                    data-testid="health-row"
                    data-source={e.source}
                    data-state={e.state}
                  >
                    <span className="flex items-center gap-2">
                      <Badge tone={severityTone(e.severity)}>{severityLabel(e.severity)}</Badge>
                      <span className="text-xs font-semibold text-fg-2">{sourceLabel(e.source)}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" dir="ltr">
                        {e.code}
                      </span>
                      <span className="text-xs tabular-nums" title={t('errors.count')}>
                        ×{e.count}
                      </span>
                    </span>
                    <span className="text-sm text-fg" dir="auto">
                      {e.message}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted">
                      <span>{formatDateTime(e.last_seen_at)}</span>
                      {e.state === 'resolved' ? <Badge tone="ok">{t('errors.health.stateResolved')}</Badge> : null}
                      {path ? (
                        <button
                          type="button"
                          className="ms-auto inline-flex items-center gap-1 text-accent-fg hover:underline"
                          onClick={() => void navigate({ to: path } as never)}
                          data-testid="health-open-link"
                        >
                          <Icon name="link" size={13} />
                          {t('errors.health.fix')}
                        </button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
};
