// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import {
  type CostAccounts,
  costMetricDef,
  type CostPrice,
  type CostSettingsResponse,
  type CostSource,
  type CostSummary,
  formatCurrency,
  formatNumber,
  he,
  type MessageKey,
  t,
  tDynamic,
} from '@bines/shared';
import { api } from '../../../lib/api';

/** Owner console → Costs: queries, keys and the labels every tab shares. */
export const COSTS_KEY = ['platform', 'costs'] as const;
export const keys = {
  summary: (from: string, to: string) => [...COSTS_KEY, 'summary', from, to] as const,
  accounts: (from: string, to: string) => [...COSTS_KEY, 'accounts', from, to] as const,
  sources: [...COSTS_KEY, 'sources'] as const,
  prices: [...COSTS_KEY, 'prices'] as const,
  settings: [...COSTS_KEY, 'settings'] as const,
};

export const useCostSources = (enabled = true) =>
  useQuery({
    queryKey: keys.sources,
    queryFn: async () => (await api().get<{ data: CostSource[] }>('/platform/costs/sources')).data,
    enabled,
    // A sync runs in the background: look again while one is running.
    refetchInterval: (q) => (q.state.data?.some((s) => s.syncing) ? 5_000 : false),
  });
export const useCostPrices = () =>
  useQuery({
    queryKey: keys.prices,
    queryFn: async () => (await api().get<{ data: CostPrice[] }>('/platform/costs/prices')).data,
  });
export const useCostSettings = () =>
  useQuery({
    queryKey: keys.settings,
    queryFn: () => api().get<CostSettingsResponse>('/platform/costs/settings'),
  });
export const useCostSummary = (from: string, to: string) =>
  useQuery({
    queryKey: keys.summary(from, to),
    queryFn: () => api().get<CostSummary>(`/platform/costs/summary?from=${from}&to=${to}`),
  });
export const useCostAccounts = (from: string, to: string) =>
  useQuery({
    queryKey: keys.accounts(from, to),
    queryFn: () => api().get<CostAccounts>(`/platform/costs/accounts?from=${from}&to=${to}`),
  });

const has = (key: string) => key in he;

export const adapterLabel = (adapter: string) => tDynamic(`costs.adapter.${adapter}`);
export const sourceLabel = (s: { adapter: string; name: string | null }) => s.name || adapterLabel(s.adapter);
/** A metric's name; a metric no adapter knows (a typed one) shows as it is. */
export const metricLabel = (metric: string) =>
  has(`costs.metric.${metric}`) ? tDynamic(`costs.metric.${metric}`) : metric;
export const unitLabel = (unit: string) => (has(`costs.unit.${unit}`) ? tDynamic(`costs.unit.${unit}`) : unit);
export const metricUnit = (metric: string) => costMetricDef(metric)?.unit ?? 'amount';
export const serviceLabel = (service: string) =>
  !service ? t('costs.service.none') : has(`costs.service.${service}`) ? tDynamic(`costs.service.${service}`) : service;

/** Money in the display currency, two decimals at most. */
export const money = (n: number, currency: string) => formatCurrency(Math.round(n * 100) / 100, currency);
/** A unit price can be tiny ($0.0000045): up to 8 significant digits. */
export const unitPrice = (n: number) => formatNumber(n, { maximumSignificantDigits: 8 });
export const quantity = (n: number) =>
  formatNumber(
    n,
    Math.abs(n) >= 10_000 ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 3 },
  );

/** A stored sync failure (`{reason, details}`) as a sentence. */
export const syncErrorText = (raw: string | null | undefined) => {
  if (!raw) return '';
  try {
    const e = JSON.parse(raw) as { reason?: string; details?: Record<string, unknown> };
    const key = `error.${e.reason}`;
    if (e.reason && has(key)) {
      const vars = Object.fromEntries(
        Object.entries(e.details ?? {}).map(([k, v]) => [k, typeof v === 'number' ? v : String(v ?? '')]),
      );
      return t(key as MessageKey, vars);
    }
    return e.reason ?? raw;
  } catch {
    return raw;
  }
};

// ---------------------------------------------------------------- date ranges

export type RangeKey = 'month' | 'lastMonth' | 'd30' | 'd90' | 'custom';
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const todayIso = () => iso(new Date());
export const rangeOf = (key: Exclude<RangeKey, 'custom'>, now = new Date()) => {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (key === 'month') return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(now) };
  if (key === 'lastMonth') return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
  const days = key === 'd30' ? 30 : 90;
  return { from: iso(new Date(now.getTime() - (days - 1) * 86_400_000)), to: iso(now) };
};
