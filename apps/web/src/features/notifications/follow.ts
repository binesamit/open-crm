// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

/** Under the item's key, so live updates on the item refresh it too. */
const followKey = (accountId: string, itemId: string) => ['account', accountId, 'item', itemId, 'follow'] as const;

/**
 * Do I follow this item (D15), and the toggle. `enabled: false` until needed — a table row asks only when its
 * menu opens.
 */
export const useFollow = (accountId: string, itemId: string, enabled = true) => {
  const qc = useQueryClient();
  const key = followKey(accountId, itemId);
  const state = useQuery({
    queryKey: key,
    queryFn: () => api(accountId).get<{ following: boolean }>(`/items/${itemId}/follow`),
    enabled,
  });
  const set = useMutation({
    mutationFn: (following: boolean) =>
      api(accountId).put<{ following: boolean }>(`/items/${itemId}/follow`, { following }),
    onSuccess: (data) => qc.setQueryData(key, data),
  });
  return { following: state.data?.following, set };
};
