// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountHelpAiDto, AiConnection } from '@bines/shared';
import { Card, Picker, Segmented, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { helpKeys } from './help-api';
import { t } from '@bines/shared';

/**
 * Administration → Security → the help assistant's AI connection (plan + product decision): the platform's (default; the
 * platform pays, up to a monthly cap) or one of the account's own AI connections (the account's AI budget). The owner
 * may disallow own connections or fix the choice for this account — the switch then shows why it is locked. The
 * admin may also switch the help assistant off for the account (decision b), even on the platform's connection.
 */
export const HelpAiPanel = ({ accountId }: { accountId: string }) => {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: helpKeys.aiSettings(accountId),
    queryFn: () => api(accountId).get<AccountHelpAiDto>('/support/help/ai-settings'),
  });
  const conns = useQuery({
    queryKey: ['account', accountId, 'ai', 'connections'],
    queryFn: () => api(accountId).get<{ data: AiConnection[] }>('/ai/connections'),
  });
  const save = useMutation({
    mutationFn: (patch: { source?: 'platform' | 'own'; connection_id?: string | null; allowed?: boolean }) =>
      api(accountId).patch<AccountHelpAiDto>('/support/help/ai-settings', patch),
    onSuccess: async (res) => {
      qc.setQueryData(helpKeys.aiSettings(accountId), res);
      await qc.invalidateQueries({ queryKey: helpKeys.options(accountId) });
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const s = q.data;
  if (!s) return null;
  const list = conns.data?.data ?? [];
  const locked = !s.own_allowed && s.source === 'platform';
  return (
    <Card className="space-y-3">
      <div className="space-y-0.5" data-testid="help-ai-settings" data-source={s.source}>
        <h3 className="text-sm font-semibold text-fg">{t('help.aiSettings.title')}</h3>
        <p className="text-xs text-muted">{t('help.aiSettings.hint')}</p>
      </div>
      <label className="flex items-center justify-between gap-2">
        <span className="text-sm text-fg">{t('help.aiSettings.allowed')}</span>
        <Switch
          checked={s.allowed}
          onChange={(on) => save.mutate({ allowed: on })}
          label={t('help.aiSettings.allowed')}
          testId="help-ai-allowed"
        />
      </label>
      {s.allowed ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-fg">{t('help.aiSettings.source')}</span>
            <Segmented
              label={t('help.aiSettings.source')}
              value={s.source}
              testId="help-ai-source"
              onChange={(v) => {
                if (v === 'own' && !s.connection_id && list[0]) save.mutate({ source: v, connection_id: list[0].id });
                else save.mutate({ source: v });
              }}
              options={[
                {
                  value: 'platform' as const,
                  label: t('help.aiSettings.platform'),
                  testId: 'help-ai-source-platform',
                },
                ...(s.own_allowed || s.source === 'own'
                  ? [{ value: 'own' as const, label: t('help.aiSettings.own'), testId: 'help-ai-source-own' }]
                  : []),
              ]}
            />
          </div>
          {s.source === 'own' ? (
            <Picker
              label={t('help.aiSettings.connection')}
              value={s.connection_id ?? ''}
              placeholder={list.length ? t('help.aiSettings.pick') : t('help.aiSettings.noConnections')}
              options={list.map((c) => ({ value: c.id, label: c.name }))}
              onChange={(v) => save.mutate({ connection_id: v })}
              testId="help-ai-connection"
            />
          ) : (
            <p className="text-xs text-muted" data-testid="help-ai-usage">
              {t('help.aiSettings.usage', {
                used: s.used_usd.toFixed(2),
                cap: s.effective_cap_usd.toFixed(2),
              })}
              {locked ? ` · ${t('help.aiSettings.locked')}` : ''}
            </p>
          )}
        </>
      ) : null}
    </Card>
  );
};
