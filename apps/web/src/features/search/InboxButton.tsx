// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MyAccount } from '../../lib/api';
import { useEventStream } from '../../lib/realtime';

export const inboxKeys = {
  all: (accountId: string) => ['account', accountId, 'inbox'] as const,
  count: (accountId: string) => ['account', accountId, 'inbox', 'count'] as const,
};

/** The Inbox's unread count (07 §9.3), live from /me/events — for the sidebar's Inbox link and badge. */
export const useInboxUnread = (account: MyAccount) => {
  const qc = useQueryClient();
  const count = useQuery({
    queryKey: inboxKeys.count(account.id),
    queryFn: () => api(account.id).get<{ unread: number }>('/me/inbox/count'),
  });
  useEventStream('/me/events', account.id, (e) => {
    if (e.type.startsWith('notification.') || e.type === 'resync')
      void qc.invalidateQueries({ queryKey: inboxKeys.all(account.id) });
  });
  return count.data?.unread ?? 0;
};
