// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, type PlatformSettingsResponse, type SenderRequest, t } from '@bines/shared';
import { Badge, Button, Card, EmptyState, Notice, Segmented, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { promptDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';

export const senderRequestsKey = (status: 'pending' | 'all') => ['platform', 'sender-requests', status] as const;
const tone = { pending: 'warn', approved: 'ok', rejected: 'danger', cancelled: 'neutral' } as const;

/**
 * Owner console → custom senders (S-46): whether an account's own email sender name / Reply-To / SMS sender id
 * needs approval (on by default), and the requests — approve (it takes effect in the account) or reject with a
 * reason. The account's admin is notified either way; every decision is audited in the account.
 */
/** The senders waiting for the owner's approval (the console nav's count). */
export const usePendingSenders = (enabled = true) =>
  useQuery({
    queryKey: senderRequestsKey('pending'),
    queryFn: () => api().get<{ data: SenderRequest[] }>('/platform/sender-requests?status=pending'),
    enabled,
  });

export const SenderRequestsPanel = ({ data }: { data: PlatformSettingsResponse }) => {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'pending' | 'all'>('pending');
  const list = useQuery({
    queryKey: senderRequestsKey(status),
    queryFn: () => api().get<{ data: SenderRequest[] }>(`/platform/sender-requests?status=${status}`),
  });
  const required = data.settings.senders?.require_approval ?? true;
  const setting = useMutation({
    mutationFn: (on: boolean) =>
      api().patch<PlatformSettingsResponse>('/platform/settings', { senders: { require_approval: on } }),
    onSuccess: (res) => {
      qc.setQueryData(['platform', 'settings'], res);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const decide = useMutation({
    mutationFn: ({ r, approve, reason }: { r: SenderRequest; approve: boolean; reason?: string }) =>
      api().post<SenderRequest>(
        `/platform/sender-requests/${r.id}/${approve ? 'approve' : 'reject'}`,
        reason ? { reason } : {},
      ),
    onSuccess: async (_res, v) => {
      showToast({ message: t(v.approve ? 'owner.senders.approvedToast' : 'owner.senders.rejectedToast') });
      await qc.invalidateQueries({ queryKey: ['platform', 'sender-requests'] });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const reject = async (r: SenderRequest) => {
    const reason = await promptDialog({
      title: t('owner.senders.rejectTitle'),
      label: t('owner.senders.reason'),
      confirmLabel: t('owner.senders.reject'),
    });
    if (reason) decide.mutate({ r, approve: false, reason });
  };
  const rows = list.data?.data ?? [];
  return (
    <Card className="space-y-3">
      <div className="space-y-2" data-testid="owner-senders">
        <h3 className="text-sm font-semibold text-fg">{t('owner.senders.title')}</h3>
        <p className="text-xs text-muted">{t('owner.senders.hint')}</p>
        <label className="flex items-center gap-2.5 text-sm">
          <Switch
            checked={required}
            disabled={setting.isPending}
            onChange={(on) => setting.mutate(on)}
            label={t('owner.senders.require')}
            testId="owner-senders-require"
          />
          <span>
            {t('owner.senders.require')}
            <span className="block text-xs text-muted">{t('owner.senders.requireHint')}</span>
          </span>
        </label>
      </div>
      <Segmented
        value={status}
        onChange={setStatus}
        label={t('owner.senders.title')}
        testId="owner-senders-filter"
        options={[
          { value: 'pending', label: t('owner.senders.filter.pending'), testId: 'owner-senders-filter-pending' },
          { value: 'all', label: t('owner.senders.filter.all'), testId: 'owner-senders-filter-all' },
        ]}
      />
      {list.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
      {list.data && !rows.length ? <EmptyState title={t('owner.senders.empty')} testId="owner-senders-empty" /> : null}
      {rows.length ? (
        <ul className="overflow-hidden rounded-[12px] border border-line" data-testid="owner-senders-list">
          {rows.map((r) => (
            <li
              key={r.id}
              data-testid="owner-sender-row"
              data-status={r.status}
              data-kind={r.kind}
              className="flex items-center gap-3 border-b border-line-soft px-3.5 py-3 last:border-b-0 max-sm:flex-col max-sm:items-stretch"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-fg">
                  {r.account_name ?? r.account_id} · {t(`owner.senders.kind.${r.kind}`)}
                  <Badge tone={tone[r.status]}>{t(`owner.senders.status.${r.status}`)}</Badge>
                </span>
                <bdi dir="auto" className="text-sm break-words text-fg-2" data-testid="owner-sender-value">
                  {r.value}
                </bdi>
                <span className="text-[0.6875rem] text-muted">
                  {t('owner.senders.requested', {
                    name: r.requested_by_name ?? '—',
                    date: formatDateTime(r.created_at),
                  })}
                  {r.reason ? ` · ${r.reason}` : ''}
                </span>
              </span>
              {r.status === 'pending' ? (
                <span className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    busy={decide.isPending && decide.variables?.r.id === r.id && decide.variables.approve}
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ r, approve: true })}
                    data-testid="owner-sender-approve"
                  >
                    {t('owner.senders.approve')}
                  </Button>
                  <Button
                    variant="danger-outline"
                    size="sm"
                    disabled={decide.isPending}
                    onClick={() => void reject(r)}
                    data-testid="owner-sender-reject"
                  >
                    {t('owner.senders.reject')}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
};
