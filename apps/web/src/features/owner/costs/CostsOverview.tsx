// SPDX-License-Identifier: AGPL-3.0-only
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { type CostSummary, formatDate, formatNumber, t } from '@bines/shared';
import { Button, Card, cn, EmptyState, Notice, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../../lib/api';
import { TD, TH, TR } from '../../trash/TrashPage';
import '../../dashboards/viz.css';
import {
  metricLabel,
  money,
  quantity,
  serviceLabel,
  sourceLabel,
  unitLabel,
  useCostSources,
  useCostSummary,
} from './costs-api';

/** A source's colour: its place among the sources (fixed while the list is), never its rank by cost. */
const slot = (i: number) => (i < 8 ? `var(--viz-${i + 1})` : 'var(--viz-other)');

const Tile = ({
  label,
  value,
  note,
  tone,
  testId,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'danger';
  testId: string;
}) => (
  <Card className="space-y-1" data-testid={testId}>
    <div className="text-xs text-muted">{label}</div>
    <div className="font-display text-2xl text-heading tabular-nums">
      <bdi>{value}</bdi>
    </div>
    {note ? <div className={cn('text-xs', tone === 'danger' ? 'text-danger-fg' : 'text-muted')}>{note}</div> : null}
  </Card>
);

const change = (now: number, before: number) => {
  if (!before) return null;
  const pct = ((now - before) / before) * 100;
  return `${pct > 0 ? '+' : ''}${formatNumber(pct, { maximumFractionDigits: 0 })}%`;
};

const DayTooltip = ({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string }[];
  label?: string;
  currency: string;
}) =>
  active && payload?.length ? (
    <div className="viz-tooltip rounded-[10px] border border-line bg-surface px-2.5 py-2 text-xs shadow-md">
      <div className="mb-1 text-muted">{label ? formatDate(label) : ''}</div>
      {payload
        .filter((p) => (p.value ?? 0) > 0)
        .map((p, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: p.color }} />
            <span className="text-fg-2">{p.name}</span>
            <span className="ms-auto ps-3 text-fg tabular-nums">{money(Number(p.value ?? 0), currency)}</span>
          </div>
        ))}
    </div>
  ) : null;

/** Daily cost, one stacked bar a day, one colour per source. */
const DailyChart = ({ summary }: { summary: CostSummary }) => {
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  const sources = summary.sources.map((s, i) => ({ ...s, fill: slot(i) }));
  const shown = sources.filter((s) => summary.days.some((d) => (d.by_source[s.id] ?? 0) > 0));
  const rows = summary.days.map((d) => ({ day: d.day, ...d.by_source }));
  const axis = { fontSize: '0.6875rem', fill: 'var(--viz-axis)' };
  if (!shown.length) return <EmptyState title={t('costs.chart.empty')} testId="costs-chart-empty" />;
  return (
    <div className="viz space-y-2" data-testid="costs-chart">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
            <XAxis
              dataKey="day"
              reversed={rtl}
              tick={axis}
              tickLine={false}
              axisLine={{ stroke: 'var(--viz-grid)' }}
              tickFormatter={(d: string) => `${Number(d.slice(8))}/${Number(d.slice(5, 7))}`}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis
              orientation={rtl ? 'right' : 'left'}
              tick={axis}
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(n: number) => formatNumber(n, { notation: 'compact', maximumFractionDigits: 1 })}
            />
            <Tooltip content={<DayTooltip currency={summary.currency} />} cursor={{ fill: 'var(--surface-2)' }} />
            {shown.map((s, i) => (
              <Bar
                key={s.id}
                dataKey={s.id}
                name={sourceLabel(s)}
                stackId="a"
                fill={s.fill}
                maxBarSize={24}
                stroke="var(--viz-gap)"
                strokeWidth={1}
                radius={i === shown.length - 1 ? [4, 4, 0, 0] : 0}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-fg-2" data-testid="costs-legend">
        {shown.map((s) => (
          <li key={s.id} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: s.fill }} />
            {sourceLabel(s)}
            <span className="text-fg tabular-nums">{money(s.total, summary.currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * Costs → Overview: the period's total against the one before, the month so far and its forecast (against the
 * budget), the daily chart by source, what needs attention (a metric with no price, a currency with no rate, a
 * failing source) and the cost of every service.
 */
export const CostsOverview = ({
  from,
  to,
  onAddPrice,
  onOpenSources,
}: {
  from: string;
  to: string;
  onAddPrice: (metric: string) => void;
  onOpenSources: (add: boolean) => void;
}) => {
  const summary = useCostSummary(from, to);
  const sources = useCostSources();
  if (summary.isPending) return <SkeletonRows rows={4} label={t('app.loading')} />;
  if (summary.isError) return <Notice tone="error">{errorMessage(summary.error)}</Notice>;
  const s = summary.data;
  const cur = s.currency;
  const vs = change(s.total, s.previous_total);
  const over = s.budget_monthly !== null && s.month_forecast > s.budget_monthly;
  const unpriced = [...new Set(s.services.filter((x) => x.unpriced).map((x) => x.metric))];
  const failing = (sources.data ?? []).filter((x) => x.enabled && x.last_sync_ok === false);
  const external = (sources.data ?? []).filter((x) => x.adapter !== 'internal');
  const byId = new Map(s.sources.map((x) => [x.id, x]));
  return (
    <div className="space-y-3" data-testid="costs-overview">
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile
          label={t('costs.kpi.total')}
          value={money(s.total, cur)}
          note={vs ? t('costs.kpi.vsPrevious', { change: vs }) : t('costs.kpi.noPrevious')}
          testId="costs-kpi-total"
        />
        <Tile label={t('costs.kpi.monthToDate')} value={money(s.month_to_date, cur)} testId="costs-kpi-mtd" />
        <Tile
          label={t('costs.kpi.forecast')}
          value={money(s.month_forecast, cur)}
          note={
            s.budget_monthly === null
              ? undefined
              : over
                ? t('costs.kpi.overBudget', { budget: money(s.budget_monthly, cur) })
                : t('costs.kpi.budget', { budget: money(s.budget_monthly, cur) })
          }
          tone={over ? 'danger' : undefined}
          testId="costs-kpi-forecast"
        />
      </div>

      {failing.length ? (
        <Notice tone="error">
          {t('costs.notice.failing', { list: failing.map(sourceLabel).join(', ') })}{' '}
          <Button size="sm" variant="ghost" onClick={() => onOpenSources(false)}>
            {t('costs.tab.sources')}
          </Button>
        </Notice>
      ) : null}
      {s.missing_rates.length ? (
        <Notice tone="warn">
          <div data-testid="costs-missing-rates">
            {t('costs.notice.missingRates', { list: s.missing_rates.join(', ') })}
          </div>
        </Notice>
      ) : null}
      {unpriced.length ? (
        <Notice tone="warn">
          <div data-testid="costs-unpriced">
            {t('costs.notice.unpriced', { list: unpriced.map(metricLabel).join(', ') })}
          </div>
        </Notice>
      ) : null}
      {sources.data && !external.length ? (
        <Notice tone="info">
          {t('costs.notice.noSources')}{' '}
          <Button size="sm" variant="ghost" onClick={() => onOpenSources(true)} data-testid="costs-connect-first">
            {t('costs.source.add')}
          </Button>
        </Notice>
      ) : null}

      <Card className="space-y-2">
        <h3 className="text-sm text-heading">{t('costs.chart.title')}</h3>
        <DailyChart summary={s} />
      </Card>

      {s.services.length ? (
        <section className="space-y-1.5">
          <h3 className="text-sm text-heading">{t('costs.services.title')}</h3>
          <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
            <table className="w-full min-w-[680px] border-collapse text-sm" data-testid="costs-services">
              <thead>
                <tr>
                  <th className={TH}>{t('costs.services.source')}</th>
                  <th className={TH}>{t('costs.services.service')}</th>
                  <th className={TH}>{t('costs.services.metric')}</th>
                  <th className={TH}>{t('costs.services.quantity')}</th>
                  <th className={TH}>{t('costs.services.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {s.services.map((x) => {
                  const src = byId.get(x.source_id);
                  return (
                    <tr
                      key={`${x.source_id}|${x.service}|${x.metric}`}
                      className={TR}
                      data-testid="costs-service-row"
                      data-metric={x.metric}
                    >
                      <td className={TD}>{src ? sourceLabel(src) : ''}</td>
                      <td className={TD}>
                        <bdi>{serviceLabel(x.service)}</bdi>
                      </td>
                      <td className={TD}>{metricLabel(x.metric)}</td>
                      <td className={cn(TD, 'tabular-nums')}>
                        <bdi>
                          {quantity(x.quantity)} {unitLabel(x.unit)}
                        </bdi>
                      </td>
                      <td className={cn(TD, 'tabular-nums')}>
                        {x.unpriced ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onAddPrice(x.metric)}
                            data-testid="costs-add-price"
                          >
                            {t('costs.services.addPrice')}
                          </Button>
                        ) : (
                          <bdi>{money(x.total, cur)}</bdi>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
};
