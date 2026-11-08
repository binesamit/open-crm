// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, type RecoveryLink, type SupportRecoveryRequest, t } from '@bines/shared';
import { Badge, Button, Dialog, Notice } from '@bines/ui';
import { api, type PlatformAccount, queryKeys } from '../../lib/api';
import { CopyLinkField, reasonMessage } from '../account/CopyLink';

export const emergencyKey = ['platform', 'emergency-recovery'] as const;
const tone = { waiting: 'info', ready: 'ok', used: 'neutral', cancelled: 'danger' } as const;

export const useEmergencyRequests = (enabled = true) =>
  useQuery({
    queryKey: emergencyKey,
    queryFn: () => api().get<{ data: SupportRecoveryRequest[] }>('/platform/emergency-recovery'),
    enabled,
  });

/** Still open: waiting for the wait to pass, or ready for the owner to make the link. */
export const isOpenEmergency = (r: SupportRecoveryRequest) => r.status === 'waiting' || r.status === 'ready';

/**
 * Owner console → emergency recovery requests: a recovery link asked for without a support grant.
 * The account's admins were emailed; it opens after the platform's wait unless one of them cancels it. When ready,
 * "get the link" makes the one-time link (single use, audited in the account). Hidden while there are none.
 */
export const EmergencyRequests = () => {
  const qc = useQueryClient();
  const list = useEmergencyRequests();
  // The account names (its own section now,, so the accounts list may not be loaded yet).
  const accounts =
    useQuery({
      queryKey: queryKeys.platformAccounts,
      queryFn: () => api().get<{ data: PlatformAccount[] }>('/platform/accounts'),
    }).data?.data ?? [];
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  const [shown, setShown] = useState<{ email: string; url: string } | null>(null);
  const link = useMutation({
    mutationFn: (r: SupportRecoveryRequest) => api().post<RecoveryLink>(`/platform/emergency-recovery/${r.id}/link`),
    onSuccess: async (res, r) => {
      setShown({ email: r.email, url: res.url });
      await qc.invalidateQueries({ queryKey: emergencyKey });
    },
  });
  const rows = list.data?.data ?? [];
  if (!rows.length) return null;
  return (
    <section className="space-y-2.5" data-testid="owner-emergency">
      <header className="space-y-0.5">
        <h2 className="font-display text-base font-bold text-heading">{t('support.emergency.ownerTitle')}</h2>
        <p className="max-w-[640px] text-xs text-muted">{t('support.emergency.ownerHint')}</p>
      </header>
      {link.isError ? <Notice tone="error">{reasonMessage(link.error)}</Notice> : null}
      <ul className="overflow-hidden rounded-[12px] border border-line bg-surface">
        {rows.map((r) => (
          <li
            key={r.id}
            data-testid="owner-emergency-row"
            data-status={r.status}
            className="flex items-center gap-3 border-b border-line-soft px-3.5 py-3 last:border-b-0 max-sm:flex-col max-sm:items-stretch"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-fg">
                {name(r.account_id)} · <bdi dir="ltr">{r.email}</bdi>
                <Badge tone={tone[r.status]}>{t(`support.emergency.status.${r.status}`)}</Badge>
              </span>
              <span className="text-xs break-words text-fg-2">{r.reason}</span>
              <span className="text-[0.6875rem] text-muted">
                {t('support.emergency.opens', { date: formatDateTime(r.available_at) })}
                {r.cancelled_by_name ? ` · ${t('support.emergency.cancelledBy', { name: r.cancelled_by_name })}` : ''}
              </span>
            </span>
            {r.status === 'ready' ? (
              <Button
                variant="secondary"
                size="sm"
                busy={link.isPending && link.variables?.id === r.id}
                onClick={() => link.mutate(r)}
                data-testid="owner-emergency-link"
              >
                {t('support.emergency.getLink')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {shown ? (
        <Dialog open onClose={() => setShown(null)} title={t('adminUsers.recovery.title')} subtitle={shown.email}>
          <div className="space-y-3 whitespace-normal" data-testid="owner-emergency-link-dialog">
            <CopyLinkField url={shown.url} testId="owner-emergency-link-field" />
            <p className="text-xs text-muted">{t('adminUsers.recovery.note')}</p>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
};
