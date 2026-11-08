// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DASHBOARD_BOARDS_MAX,
  t,
  type DashboardDetail,
  type DashboardSourceOptions,
  type MyAccount,
} from '@bines/shared';
import { Button, Dialog, Input, Notice, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { useWorkspaces } from '../board/board-api';
import { dashboardKeys, useDashboardMutations } from './dashboard-api';
import { SearchClear } from '../../lib/search-clear';

/**
 * "לוחות" of a dashboard (plan §4): the source boards — any board of the account I can read, from every
 * workspace, up to 50. Boards already on it that I cannot read stay (they are counted, not named).
 */
export const DashboardSourcesDialog = ({
  account,
  dashboard,
  onClose,
}: {
  account: MyAccount;
  dashboard: DashboardDetail;
  onClose: () => void;
}) => {
  const workspaces = useWorkspaces(account.id).data?.data ?? [];
  // One list of every board I may read (not a tree per workspace: ~150 workspaces queued "save" behind them).
  const options = useQuery({
    queryKey: dashboardKeys.sourceOptions(account.id),
    queryFn: () => api(account.id).get<DashboardSourceOptions>('/dashboards/source-options'),
  });
  const byWorkspace = useMemo(() => {
    const m = new Map<string, DashboardSourceOptions['data']>();
    for (const b of options.data?.data ?? []) m.set(b.workspace_id, [...(m.get(b.workspace_id) ?? []), b]);
    return m;
  }, [options.data]);
  const mut = useDashboardMutations(account.id);
  const [chosen, setChosen] = useState<string[]>(dashboard.settings.board_ids);
  const [q, setQ] = useState('');
  const needle = q.trim().toLocaleLowerCase();
  const readable = new Set(dashboard.boards.map((b) => b.id));
  const toggle = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length < DASHBOARD_BOARDS_MAX ? [...c, id] : c));
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('dashboards.sources.title')}
      subtitle={t('dashboards.sources.count', { n: chosen.length, max: DASHBOARD_BOARDS_MAX })}
      className="max-w-lg!"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            busy={mut.update.isPending}
            data-testid="dashboard-sources-save"
            onClick={() =>
              mut.update.mutate({ id: dashboard.id, settings: { board_ids: chosen } }, { onSuccess: onClose })
            }
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="dashboard-sources">
        <div className="relative">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('dashboards.sources.search')}
            aria-label={t('dashboards.sources.search')}
            className="pe-7"
          />
          <SearchClear value={q} onClear={() => setQ('')} testId="sources-search-clear" />
        </div>
        {options.isPending ? <SkeletonRows rows={4} label={t('app.loading')} /> : null}
        {options.isError ? <Notice tone="error">{errorMessage(options.error)}</Notice> : null}
        <div className="max-h-[50vh] space-y-3 overflow-auto">
          {workspaces.map((w) => {
            const boards = (byWorkspace.get(w.id) ?? []).filter(
              (b) => !needle || b.name.toLocaleLowerCase().includes(needle),
            );
            if (!boards.length) return null;
            return (
              <div key={w.id}>
                <p className="mb-1 text-xs font-semibold text-muted">{w.name}</p>
                {boards.map((b) => (
                  <label
                    key={b.id}
                    className="flex items-center gap-2 rounded-[8px] px-1.5 py-1 text-sm hover:bg-surface-2"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={chosen.includes(b.id)}
                      onChange={() => toggle(b.id)}
                      data-testid="dashboard-source-option"
                      data-name={b.name}
                    />
                    {b.name}
                  </label>
                ))}
              </div>
            );
          })}
        </div>
        {chosen.some((id) => !readable.has(id) && dashboard.settings.board_ids.includes(id)) ? (
          <p className="text-xs text-muted">{t('dashboards.sources.hiddenKept')}</p>
        ) : null}
        {mut.update.error ? <Notice tone="error">{errorMessage(mut.update.error)}</Notice> : null}
      </div>
    </Dialog>
  );
};
