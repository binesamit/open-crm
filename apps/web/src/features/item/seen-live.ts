// SPDX-License-Identifier: AGPL-3.0-only
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import {
  type Inbox,
  mergeSeen,
  SEEN_PREVIEW_LIMIT,
  type StreamEvent,
  UPDATE_SEEN,
  type UpdateDto,
  type UpdateSeen,
} from '@bines/shared';
import { useEventStream } from '../../lib/realtime';

/**
 * r16seen (product owner: "it works only after a refresh — it must be live, also for the viewer"): an `update.seen` event
 * patches the `seen` of that update wherever it is cached — the item's thread (an update or one of its replies)
 * and the Inbox pages — without refetching them. Merging is idempotent, so the same event heard on two channels
 * (the board page and an item card on another board) changes nothing the second time.
 */
export const applySeenEvent = (qc: QueryClient, accountId: string, e: StreamEvent) => {
  if (e.type !== UPDATE_SEEN || !e.update_id || !e.seen) return;
  const id = e.update_id;
  const live = e.seen;
  const patch = <T extends { id: string; seen?: UpdateSeen | null }>(u: T): T =>
    u.id === id && u.seen !== null ? { ...u, seen: mergeSeen(u.seen, live, SEEN_PREVIEW_LIMIT) } : u;

  if (e.item_id) {
    qc.setQueryData<{ data: UpdateDto[] }>(['account', accountId, 'item', e.item_id, 'updates'], (old) =>
      old ? { ...old, data: old.data.map((u) => ({ ...patch(u), replies: u.replies.map(patch) })) } : old,
    );
  }
  // Inbox pages (infinite queries under ['account', id, 'inbox', …]; the count query has no pages).
  qc.setQueriesData<{ pages: Inbox[]; pageParams: unknown[] }>({ queryKey: ['account', accountId, 'inbox'] }, (old) =>
    old && Array.isArray(old.pages)
      ? { ...old, pages: old.pages.map((p) => ({ ...p, data: p.data.map(patch) })) }
      : old,
  );
  // The full list (opened when more people saw it than the update carries) loads again the next time it shows.
  void qc.invalidateQueries({ queryKey: ['account', accountId, 'update-views', id] });
};

/**
 * Listens for `update.seen` on a board's channel (sub-board included). The item card mounts it for the item's own
 * root board — the channel is shared, so on the board page itself this opens no second connection.
 */
export const useSeenLive = (accountId: string, boardId: string | null | undefined) => {
  const qc = useQueryClient();
  useEventStream(boardId ? `/boards/${boardId}/events` : null, accountId, (e) => applySeenEvent(qc, accountId, e));
};

/** The Inbox hears `update.seen` of its entries on /me/events (the server sends only updates in my Inbox). */
export const useInboxSeenLive = (accountId: string) => {
  const qc = useQueryClient();
  useEventStream('/me/events', accountId, (e) => applySeenEvent(qc, accountId, e));
};
