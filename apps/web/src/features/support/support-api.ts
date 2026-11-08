// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import {
  t,
  type TicketDetail,
  type TicketOptions,
  type TicketPriority,
  type TicketStatus,
  type TicketSummary,
  tDynamic,
} from '@bines/shared';
import { api } from '../../lib/api';

/** Support tickets, the customer's side: query keys, hooks and labels shared by the pages. */

export const ticketKeys = {
  all: (accountId: string) => ['account', accountId, 'tickets'] as const,
  list: (accountId: string, status: string) => ['account', accountId, 'tickets', 'list', status] as const,
  one: (accountId: string, id: string) => ['account', accountId, 'tickets', 'one', id] as const,
  options: (accountId: string) => ['account', accountId, 'tickets', 'options'] as const,
  settings: (accountId: string) => ['account', accountId, 'tickets', 'settings'] as const,
};

export const useTicketOptions = (accountId: string, enabled = true) =>
  useQuery({
    queryKey: ticketKeys.options(accountId),
    queryFn: () => api(accountId).get<TicketOptions>('/support/tickets/options'),
    enabled,
    staleTime: 60_000,
  });

export const useMyTickets = (accountId: string, status: 'open' | 'done' | 'all') =>
  useQuery({
    queryKey: ticketKeys.list(accountId, status),
    queryFn: () =>
      api(accountId).get<{ data: TicketSummary[]; next_cursor: string | null }>(
        `/support/tickets${status === 'all' ? '' : `?status=${status}`}`,
      ),
  });

export const useTicket = (accountId: string, id: string) =>
  useQuery({
    queryKey: ticketKeys.one(accountId, id),
    queryFn: () => api(accountId).get<TicketDetail>(`/support/tickets/${id}`),
  });

export const statusLabel = (s: TicketStatus) => t(`tickets.status.${s}`);
export const priorityLabel = (p: TicketPriority) => t(`tickets.priority.${p}`);

/** Badge tones per status (the same in "My tickets" and the console). */
export const statusTone = (s: TicketStatus): 'ok' | 'neutral' | 'warn' | 'info' | 'violet' =>
  s === 'new'
    ? 'info'
    : s === 'open'
      ? 'warn'
      : s === 'pending_customer'
        ? 'violet'
        : s === 'solved' || s === 'closed'
          ? 'ok'
          : 'neutral';

/** A system line of the thread ("access.approved:view:4") in words. */
export const systemText = (body: string) => {
  const [key, mode, hours] = body.split(':');
  if (key === 'access.approved')
    return t('tickets.system.accessApproved', { mode: tDynamic(`support.mode.${mode ?? 'view'}`), hours: hours ?? '' });
  if (key === 'access.declined') return t('tickets.system.accessDeclined');
  return body;
};
