// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  boardChartData,
  t,
  viewChartSchema,
  type BoardChartData,
  type MyAccount,
  type Query,
  type QueryEnv,
  type QueryRow,
  type ViewSettings,
  type Widget,
  type WidgetData,
} from '@bines/shared';
import { Card, EmptyState, Notice } from '@bines/ui';
import { api } from '../../../lib/api';
import { ChartDrawing } from '../../dashboards/WidgetViews';
import '../../dashboards/viz.css';
import type { BoardDetail, Item, Member } from '../board-api';
import { groupColor } from '../table/BoardTable';
import { BoardAccountContext } from '../board-context';

/**
 * The Chart view (M8 ד9): the dashboard chart widget's drawing on this board — over the view's matching items,
 * computed in the browser (`boardChartData`, live with the board), or by the server for a windowed board whose
 * rows the browser does not hold. Type, axis, series and measure are view settings (the view settings panel).
 */

export const BoardChartView = ({
  board,
  items,
  settings,
  query,
  env,
  members,
  windowed,
}: {
  board: BoardDetail;
  items: Item[];
  settings: ViewSettings;
  query: Query;
  env: QueryEnv;
  members: Member[];
  windowed: boolean;
}) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const chart = useMemo(() => viewChartSchema.parse(settings.chart ?? {}), [settings.chart]);
  const local = useMemo<BoardChartData | null>(() => {
    if (windowed) return null;
    const names = new Map(members.map((m) => [m.user_id, m.name || m.email]));
    return boardChartData(items as unknown as QueryRow[], chart, env, {
      groups: board.groups.map((g) => ({ id: g.id, title: g.title, color: groupColor(g) })),
      nameOf: (id) => names.get(id),
    });
  }, [windowed, items, chart, env, board.groups, members]);
  const remote = useQuery({
    queryKey: ['account', accountId, 'board', board.id, 'items', 'chart', query, chart],
    queryFn: () =>
      api(accountId).post<BoardChartData & { items: number; truncated: boolean }>(`/boards/${board.id}/chart`, {
        query,
        chart,
      }),
    enabled: windowed,
  });
  const data = local ?? remote.data ?? null;
  const total = data ? data.rows.reduce((n, r) => n + Object.values(r.values).reduce((a, b) => a + b, 0), 0) : 0;
  return (
    <div className="flex flex-col gap-3 pb-6" data-testid="chart-view" data-chart-type={chart.chart_type}>
      {remote.data?.truncated ? (
        <Notice tone="info">{t('chartView.truncated', { n: remote.data.items })}</Notice>
      ) : null}
      <Card className="h-[460px] p-4 max-md:h-[360px]">
        {!data ? null : !data.rows.length || !total ? (
          <EmptyState title={t('chartView.empty')}>{t('chartView.emptyHint')}</EmptyState>
        ) : (
          <ChartDrawing
            account={{} as MyAccount}
            widget={{ settings: { chart_type: chart.chart_type } } as unknown as Widget}
            data={{ data } as unknown as WidgetData<never>}
          />
        )}
      </Card>
      {data && data.rows.length ? (
        // The table view of the chart (dataviz: values never by colour alone).
        <table className="w-full max-w-xl text-sm" data-testid="chart-table">
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.key} className="border-b border-line-soft" data-testid="chart-row" data-label={r.label}>
                <td className="py-1 pe-3">
                  {r.key === '__empty__'
                    ? t('dashboards.none')
                    : r.key === '__other__'
                      ? t('dashboards.other')
                      : r.label}
                </td>
                <td className="py-1 text-end tabular-nums" data-testid="chart-value">
                  {Math.round(Object.values(r.values).reduce((a, b) => a + b, 0) * 100) / 100}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
};
