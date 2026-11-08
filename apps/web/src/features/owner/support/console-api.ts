// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import type { SupportConsoleConfig, TicketDetail, TicketSummary } from '@bines/shared';
import { api } from '../../../lib/api';
import { t } from '@bines/shared';

/** The owner console's Support section: query keys and hooks. */
export const consoleKeys = {
  config: ['platform', 'support', 'config'] as const,
  tickets: (filters: string) => ['platform', 'support', 'tickets', filters] as const,
  allTickets: ['platform', 'support', 'tickets'] as const,
  ticket: (id: string) => ['platform', 'support', 'ticket', id] as const,
  staff: ['platform', 'support', 'staff'] as const,
  report: (days: number) => ['platform', 'support', 'report', days] as const,
};

export const useConsoleConfig = () =>
  useQuery({
    queryKey: consoleKeys.config,
    queryFn: () => api().get<SupportConsoleConfig>('/platform/support/config'),
  });

export const useConsoleTickets = (filters: Record<string, string>) => {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  return useQuery({
    queryKey: consoleKeys.tickets(qs),
    queryFn: () =>
      api().get<{ data: TicketSummary[]; next_cursor: string | null }>(
        `/platform/support/tickets${qs ? `?${qs}` : ''}`,
      ),
    refetchInterval: 60_000,
  });
};

export const useConsoleTicket = (id: string) =>
  useQuery({
    queryKey: consoleKeys.ticket(id),
    queryFn: () => api().get<TicketDetail>(`/platform/support/tickets/${id}`),
  });

/** "45 דק'", "3 ש'", "2 ימים" — an SLA target or a measured time. */
export const minutesLabel = (m: number | null | undefined) => {
  if (m === null || m === undefined) return '—';
  if (m < 60) return t('tickets.time.minutes', { n: m });
  if (m < 60 * 24) return t('tickets.time.hours', { n: Math.round((m / 60) * 10) / 10 });
  return t('tickets.time.days', { n: Math.round((m / 1440) * 10) / 10 });
};
