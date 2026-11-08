// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AccountWebSearch,
  t,
  type UpdateAccountWebSearch,
  WEB_SEARCH_PROVIDERS,
  type WebSearchProvider,
} from '@bines/shared';
import { Badge, Button, Card, Field, Input, Notice, Segmented } from '@bines/ui';
import { api, errorMessage, type MyAccount } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { SecretField } from '../licensing/LicenseOpsCards';

const keyOf = (accountId: string) => ['account', accountId, 'ai', 'web-search'] as const;

/**
 * Administration → AI → "Web search for agents": the search service (Brave Search or Tavily) and its
 * key — write-only, sealed on the server — and the limits per run and per day. Agents search only after an admin
 * approves it for each of them (the agent's editor), and only while the platform owner allows web search.
 */
export const WebSearchCard = ({ account }: { account: MyAccount }) => {
  const qc = useQueryClient();
  const data = useQuery({
    queryKey: keyOf(account.id),
    queryFn: () => api(account.id).get<AccountWebSearch>('/ai/web-search'),
  });
  const [provider, setProvider] = useState<WebSearchProvider | null>(null);
  const [key, setKey] = useState('');
  const [perRun, setPerRun] = useState<string | null>(null);
  const [perDay, setPerDay] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (patch: UpdateAccountWebSearch) => api(account.id).patch<AccountWebSearch>('/ai/web-search', patch),
    onSuccess: (next) => {
      qc.setQueryData(keyOf(account.id), next);
      setKey('');
      setPerRun(null);
      setPerDay(null);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
  });
  if (data.isError) return <Notice tone="error">{errorMessage(data.error)}</Notice>;
  const w = data.data;
  if (!w) return null;
  const chosen = provider ?? w.provider ?? 'brave';
  const run = perRun ?? String(w.max_per_run);
  const day = perDay ?? String(w.max_per_day);
  const submit = () => {
    const patch: UpdateAccountWebSearch = { provider: chosen };
    if (key.trim()) patch.key = key.trim();
    if (Number(run) >= 1) patch.max_per_run = Number(run);
    if (Number(day) >= 1) patch.max_per_day = Number(day);
    save.mutate(patch);
  };
  return (
    <Card className="space-y-3" data-testid="web-search-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-fg">{t('webSearch.title')}</h3>
          <p className="max-w-[640px] text-xs text-muted">{t('webSearch.hint')}</p>
        </div>
        <span data-testid="web-search-state" data-ready={w.ready ? 'yes' : 'no'}>
          <Badge tone={w.ready ? 'ok' : 'neutral'}>{t(w.ready ? 'webSearch.ready' : 'webSearch.notReady')}</Badge>
        </span>
      </div>
      {!w.platform_enabled ? <Notice tone="info">{t('webSearch.platformOff')}</Notice> : null}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t('webSearch.provider')}>
          <Segmented
            label={t('webSearch.provider')}
            value={chosen}
            onChange={setProvider}
            testId="web-search-provider"
            options={WEB_SEARCH_PROVIDERS.map((p) => ({
              value: p,
              label: t(`webSearch.provider.${p}`),
              testId: `web-search-provider-${p}`,
            }))}
          />
        </Field>
        <SecretField
          label={t('webSearch.key')}
          set={w.key_set}
          value={key}
          onChange={setKey}
          placeholder={w.key_hint ?? '••••••••'}
          onClear={() => save.mutate({ key: null })}
          testId="web-search-key"
        />
        <div className="flex flex-wrap gap-3">
          <Field label={t('webSearch.maxPerRun')}>
            <Input
              dir="ltr"
              inputMode="numeric"
              value={run}
              onChange={(e) => setPerRun(e.target.value.replace(/[^\d]/g, ''))}
              data-testid="web-search-per-run"
            />
          </Field>
          <Field label={t('webSearch.maxPerDay')} hint={t('webSearch.usedToday', { n: w.used_today })}>
            <Input
              dir="ltr"
              inputMode="numeric"
              value={day}
              onChange={(e) => setPerDay(e.target.value.replace(/[^\d]/g, ''))}
              data-testid="web-search-per-day"
            />
          </Field>
        </div>
        <Button type="submit" size="sm" variant="secondary" busy={save.isPending} data-testid="web-search-save">
          {t('common.save')}
        </Button>
      </form>
    </Card>
  );
};
