// SPDX-License-Identifier: AGPL-3.0-only
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

/** Top-level updates per item of a board (N4: the count pill on rows, kanban and cards; the card's tab). */
export const updateCountsKey = (accountId: string, boardId: string) =>
  ['account', accountId, 'board', boardId, 'update-counts'] as const;

export const useUpdateCounts = (accountId: string, boardId: string | undefined) =>
  useQuery({
    queryKey: updateCountsKey(accountId, boardId ?? ''),
    queryFn: () =>
      api(accountId)
        .get<{ counts: Record<string, number> }>(`/boards/${boardId}/update-counts`)
        .then((r) => r.counts),
    enabled: !!boardId,
    staleTime: 30_000,
  });

/** After posting or deleting an update in this tab (SSE skips the tab's own events). */
export const invalidateUpdateCounts = (qc: QueryClient, accountId: string, boardId: string) =>
  qc.invalidateQueries({ queryKey: updateCountsKey(accountId, boardId) });
