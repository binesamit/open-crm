// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Favorite, Favorites, FavoriteType } from '@bines/shared';
import { api } from '../../lib/api';

/** The one favourites list (Fix: ): boards, docs and dashboards, in my order. */
export const favoritesKey = (accountId: string) => ['account', accountId, 'favorites'] as const;
/** The docs feature's own cache of my starred docs (GET /me/favorite-docs) — kept in step with this list. */
const docFavoritesKey = (accountId: string) => ['account', accountId, 'favorite-docs'] as const;

/** A sortable id that is unique across types (a board and a doc may never share an id, but be explicit). */
export const favoriteKey = (f: Pick<Favorite, 'type' | 'id'>) => `${f.type}:${f.id}`;

export type FavoriteTarget = {
  type: FavoriteType;
  id: string;
  name: string;
  workspace_id: string;
  icon?: string | null;
};

/**
 * My favourites in this account (fix2 boards, M8 docs, Fix: dashboards — one list): kept on the server per
 * user, in my order, across workspaces. The star and reordering apply optimistically; what I can no longer open
 * never comes back from the server.
 */
export const useAllFavorites = (accountId: string) => {
  const qc = useQueryClient();
  const key = favoritesKey(accountId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => api(accountId).get<Favorites>('/me/favorites'),
    staleTime: 60_000,
  });
  const list = query.data?.data ?? [];
  const save = useMutation({
    mutationFn: (next: Favorite[]) =>
      api(accountId).put<Favorites>('/me/favorites', { items: next.map((f) => ({ type: f.type, id: f.id })) }),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<Favorites>(key);
      qc.setQueryData<Favorites>(key, { data: next });
      return { before };
    },
    // A failed save re-reads the list instead of restoring its snapshot: two quick toggles make two saves, and
    // restoring the first one's snapshot after the second succeeded would drop both (audit 2026-10-10 web #7).
    onError: () => void qc.invalidateQueries({ queryKey: key }),
    onSuccess: (res) => {
      qc.setQueryData(key, res);
      // The doc page's star reads its own list.
      void qc.invalidateQueries({ queryKey: docFavoritesKey(accountId) });
    },
  });
  const isFavorite = (type: FavoriteType, id: string) => list.some((f) => f.type === type && f.id === id);
  const toggle = (target: FavoriteTarget) =>
    save.mutate(
      isFavorite(target.type, target.id)
        ? list.filter((f) => !(f.type === target.type && f.id === target.id))
        : [...list, { ...target, icon: target.icon ?? null }],
    );
  /** Drag to reorder: `key` takes the place of `overKey` (both `favoriteKey`s); the whole list is saved. */
  const move = (from: string, over: string) => {
    const a = list.findIndex((f) => favoriteKey(f) === from);
    const b = list.findIndex((f) => favoriteKey(f) === over);
    if (a < 0 || b < 0 || a === b) return;
    const next = [...list];
    next.splice(b, 0, ...next.splice(a, 1));
    save.mutate(next);
  };
  return { list, loaded: query.isSuccess, isFavorite, toggle, move, error: save.error };
};
export type AllFavorites = ReturnType<typeof useAllFavorites>;

/**
 * One type's view of the list — what a star on a board / doc / dashboard row needs (`isFavorite(id)`,
 * `toggle(entity)`), on the same shared list.
 */
export const favoritesOf = (all: AllFavorites, type: FavoriteType) => ({
  list: all.list.filter((f) => f.type === type),
  loaded: all.loaded,
  error: all.error,
  isFavorite: (id: string) => all.isFavorite(type, id),
  toggle: (e: { id: string; name: string; workspace_id: string; icon?: string | null }) => all.toggle({ ...e, type }),
});

/** My favourite boards (fix2) — the boards of the one list. */
export const useFavorites = (accountId: string) => favoritesOf(useAllFavorites(accountId), 'board');
