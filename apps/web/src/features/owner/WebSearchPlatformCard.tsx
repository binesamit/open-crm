// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type PlatformWebSearch, t } from '@bines/shared';
import { Card, Notice, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';

const key = ['platform', 'web-search'] as const;

/**
 * Owner console → AI → "Web search for agents": the master switch for every account. Off by default
 * on, an account still needs its own search service key and an admin's approval per agent.
 */
export const WebSearchPlatformCard = () => {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: key, queryFn: () => api().get<PlatformWebSearch>('/platform/web-search') });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api().patch<PlatformWebSearch>('/platform/web-search', { enabled }),
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
  });
  if (data.isError) return <Notice tone="error">{errorMessage(data.error)}</Notice>;
  if (!data.data) return null;
  return (
    <Card className="space-y-2" data-testid="platform-web-search">
      <label className="flex items-center justify-between gap-3">
        <span className="space-y-0.5">
          <span className="block text-sm font-semibold text-fg">{t('webSearch.platform.title')}</span>
          <span className="block max-w-[640px] text-xs text-muted">{t('webSearch.platform.hint')}</span>
        </span>
        <Switch
          checked={data.data.enabled}
          disabled={save.isPending}
          onChange={(v) => save.mutate(v)}
          label={t('webSearch.platform.title')}
          testId="platform-web-search-switch"
        />
      </label>
    </Card>
  );
};
