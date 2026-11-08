// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountTicketSettings } from '@bines/shared';
import { Card, Segmented } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { HelpAiPanel } from './HelpAiPanel';
import { ticketKeys } from './support-api';
import { t } from '@bines/shared';

/**
 * Administration → Security → Support tickets: who may open tickets (every member, default, or admins
 * only) and whether members see only their own tickets or all of the account's. Admins approve support's access.
 */
export const TicketSettingsPanel = ({ accountId }: { accountId: string }) => {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ticketKeys.settings(accountId),
    queryFn: () => api(accountId).get<AccountTicketSettings>('/support/tickets/settings'),
  });
  const save = useMutation({
    mutationFn: (patch: Partial<AccountTicketSettings>) =>
      api(accountId).patch<AccountTicketSettings>('/support/tickets/settings', patch),
    onSuccess: async (res) => {
      qc.setQueryData(ticketKeys.settings(accountId), res);
      await qc.invalidateQueries({ queryKey: ticketKeys.options(accountId) });
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const s = q.data;
  if (!s) return null;
  return (
    <>
      <Card className="space-y-3">
        <div className="space-y-0.5" data-testid="ticket-settings">
          <h3 className="text-sm font-semibold text-fg">{t('tickets.settings.title')}</h3>
          <p className="text-xs text-muted">{t('tickets.settings.hint')}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-fg">{t('tickets.settings.whoOpens')}</span>
          <Segmented
            label={t('tickets.settings.whoOpens')}
            value={s.who_can_open}
            onChange={(v) => save.mutate({ who_can_open: v })}
            testId="ticket-settings-who"
            options={[
              { value: 'members' as const, label: t('tickets.settings.members') },
              { value: 'admins' as const, label: t('tickets.settings.admins') },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-fg">{t('tickets.settings.membersSee')}</span>
          <Segmented
            label={t('tickets.settings.membersSee')}
            value={s.members_see}
            onChange={(v) => save.mutate({ members_see: v })}
            testId="ticket-settings-see"
            options={[
              { value: 'own' as const, label: t('tickets.settings.own') },
              { value: 'all' as const, label: t('tickets.settings.all') },
            ]}
          />
        </div>
      </Card>
      {/* The help assistant's AI connection: the platform's, capped, or the account's own. */}
      <HelpAiPanel accountId={accountId} />
    </>
  );
};
