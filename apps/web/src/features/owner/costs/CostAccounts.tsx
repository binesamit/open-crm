// SPDX-License-Identifier: AGPL-3.0-only
import { t, tDynamic } from '@bines/shared';
import { cn, EmptyState, Notice, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../../lib/api';
import { TD, TH, TR } from '../../trash/TrashPage';
import { money, useCostAccounts } from './costs-api';

/**
 * Costs → By account: each account's own costs (what the platform measured on it) and its share of the shared ones
 * (servers, storage, fees — split as the settings say), against what its plan charges for the same days.
 */
export const CostAccounts = ({ from, to }: { from: string; to: string }) => {
  const q = useCostAccounts(from, to);
  if (q.isPending) return <SkeletonRows rows={4} label={t('app.loading')} />;
  if (q.isError) return <Notice tone="error">{errorMessage(q.error)}</Notice>;
  const r = q.data;
  const cur = r.currency;
  return (
    <div className="space-y-2" data-testid="cost-accounts">
      <p className="text-xs text-muted">
        {t('costs.accounts.sharedNote', {
          amount: money(r.shared_total, cur),
          method: tDynamic(`costs.accounts.method.${r.allocation}`),
        })}
      </p>
      {!r.data.length ? (
        <EmptyState title={t('costs.accounts.none')} />
      ) : (
        <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH}>{t('costs.accounts.account')}</th>
                <th className={TH}>{t('costs.accounts.plan')}</th>
                <th className={TH}>{t('costs.accounts.direct')}</th>
                <th className={TH}>{t('costs.accounts.shared')}</th>
                <th className={TH}>{t('costs.accounts.total')}</th>
                <th className={TH}>{t('costs.accounts.revenue')}</th>
                <th className={TH}>{t('costs.accounts.margin')}</th>
              </tr>
            </thead>
            <tbody>
              {r.data.map((a) => (
                <tr key={a.account_id} className={TR} data-testid="cost-account-row">
                  <td className={TD} dir="auto">
                    {a.name}
                  </td>
                  <td className={TD}>{a.plan ?? t('costs.accounts.noPlan')}</td>
                  {[a.direct, a.shared, a.total].map((v, i) => (
                    <td key={i} className={cn(TD, 'tabular-nums')}>
                      <bdi>{money(v, cur)}</bdi>
                    </td>
                  ))}
                  <td className={cn(TD, 'tabular-nums')}>
                    <bdi>{a.revenue === null ? '—' : money(a.revenue, cur)}</bdi>
                  </td>
                  <td
                    className={cn(TD, 'tabular-nums', a.margin !== null && a.margin < 0 ? 'text-danger-fg' : '')}
                    data-testid="cost-account-margin"
                  >
                    <bdi>{a.margin === null ? '—' : money(a.margin, cur)}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
