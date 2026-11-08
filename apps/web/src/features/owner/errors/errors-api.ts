// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import {
  type ErrorAlert,
  type ErrorDetail,
  type ErrorEvent,
  type ErrorHubConfig,
  type ErrorSeverity,
  type ErrorSource,
  type ErrorStatus,
  t,
} from '@bines/shared';
import { api } from '../../../lib/api';

/** The owner console's "Errors & health" section: query keys, hooks and labels. */

export const errorKeys = {
  all: ['platform', 'errors'] as const,
  config: ['platform', 'errors', 'config'] as const,
  list: (qs: string) => ['platform', 'errors', 'list', qs] as const,
  accounts: ['platform', 'errors', 'accounts'] as const,
  detail: (id: string) => ['platform', 'errors', 'detail', id] as const,
  alerts: ['platform', 'errors', 'alerts'] as const,
};

export const useErrorConfig = () =>
  useQuery({ queryKey: errorKeys.config, queryFn: () => api().get<ErrorHubConfig>('/platform/errors/config') });

export const useErrorList = (filters: Record<string, string>) => {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  return useQuery({
    queryKey: errorKeys.list(qs),
    queryFn: () => api().get<{ data: ErrorEvent[]; total: number }>(`/platform/errors${qs ? `?${qs}` : ''}`),
    // Always fresh: a search typed again must show an error that arrived since (not the app's 30 s cached answer).
    staleTime: 0,
    refetchInterval: 60_000,
  });
};

export type AccountSummary = {
  account: { id: string; name: string; slug: string } | null;
  open: number;
  critical: number;
  occurrences_24h: number;
  last_seen_at: string | null;
};
export const useErrorAccounts = () =>
  useQuery({
    queryKey: errorKeys.accounts,
    queryFn: () => api().get<{ data: AccountSummary[] }>('/platform/errors/accounts'),
  });

export const useErrorDetail = (id: string) =>
  useQuery({ queryKey: errorKeys.detail(id), queryFn: () => api().get<ErrorDetail>(`/platform/errors/${id}`) });

/** `enabled` = false: no call (people outside the owner / support staff). */
export const useErrorAlerts = (enabled = true) =>
  useQuery({
    enabled,
    queryKey: errorKeys.alerts,
    queryFn: () => api().get<{ data: ErrorAlert[]; unread: number }>('/platform/errors/alerts'),
    refetchInterval: 60_000,
  });

export const sourceLabel = (s: ErrorSource) => t(`errors.source.${s}`);
export const severityLabel = (s: ErrorSeverity) => t(`errors.severity.${s}`);
export const statusLabel = (s: ErrorStatus) => t(`errors.status.${s}`);
export const severityTone = (s: ErrorSeverity) =>
  s === 'critical' ? 'danger' : s === 'error' ? 'warn' : s === 'warning' ? 'info' : 'neutral';
export const statusTone = (s: ErrorStatus) =>
  s === 'new' ? 'danger' : s === 'acknowledged' ? 'warn' : s === 'resolved' ? 'ok' : 'neutral';
