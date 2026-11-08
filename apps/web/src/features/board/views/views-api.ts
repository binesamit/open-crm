// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  arrangeViews,
  type Deleted,
  type View,
  type ViewLayout,
  type ViewPrefs,
  type ViewSettings,
  type ViewType,
} from '@bines/shared';
import { api, keepaliveApi } from '../../../lib/api';
import { useDeletedToast } from '../../../lib/undo';

export type { View };

type ViewList = { data: View[]; layout: ViewLayout; current_view_id: string };

export const viewKeys = {
  list: (accountId: string, boardId: string) => ['account', accountId, 'board', boardId, 'views'] as const,
  account: (accountId: string) => ['account', accountId, 'detail'] as const,
};

export const useViews = (accountId: string, boardId: string) =>
  useQuery({
    queryKey: viewKeys.list(accountId, boardId),
    queryFn: () => api(accountId).get<ViewList>(`/boards/${boardId}/views`),
  });

/** Locale settings of the account (timezone, weekend, first day) for date filters. */
export const useAccountLocale = (accountId: string) =>
  useQuery({
    queryKey: viewKeys.account(accountId),
    queryFn: () =>
      api(accountId).get<{
        settings: { locale: { timezone: string; weekend: 'fri_sat' | 'sat_sun'; first_day: number } };
      }>('/accounts/me'),
    staleTime: 10 * 60_000,
    select: (d) => d.settings.locale,
  });

/** View mutations; results are written straight into the views cache. */
export const useViewMutations = (accountId: string, boardId: string) => {
  const qc = useQueryClient();
  const client = api(accountId);
  const deleted = useDeletedToast(accountId);
  const key = viewKeys.list(accountId, boardId);
  const put = (view: View) =>
    qc.setQueryData<ViewList>(key, (old) =>
      old
        ? {
            ...old,
            data: old.data.some((v) => v.id === view.id)
              ? old.data.map((v) => (v.id === view.id ? view : v))
              : [...old.data, view].sort((a, b) => (a.position < b.position ? -1 : 1)),
          }
        : old,
    );
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  return {
    create: useMutation({
      mutationFn: (v: { name: string; type: ViewType; settings?: ViewSettings; visibility?: 'shared' | 'private' }) =>
        client.post<View>(`/boards/${boardId}/views`, v),
      onSuccess: put,
    }),
    /** Saves settings over the revision the client saw (If-Match); 409 = someone saved in between. */
    save: useMutation({
      mutationFn: (v: { view: View; settings: ViewSettings; force?: boolean }) =>
        client.patch<View>(
          `/views/${v.view.id}`,
          { settings: v.settings },
          v.force ? undefined : { 'if-match': String(v.view.revision) },
        ),
      onSuccess: put,
    }),
    update: useMutation({
      mutationFn: (v: {
        viewId: string;
        name?: string;
        is_locked?: boolean;
        is_default?: boolean;
        visibility?: 'shared';
        position?: { after_id: string } | { before_id: string } | 'top' | 'bottom';
      }) => {
        const { viewId, ...body } = v;
        return client.patch<View>(`/views/${viewId}`, body);
      },
      onSuccess: async (view, v) => {
        put(view);
        if (v.is_default || v.position) await refresh();
      },
    }),
    duplicate: useMutation({
      mutationFn: (viewId: string) => client.post<View>(`/views/${viewId}/duplicate`, {}),
      onSuccess: refresh,
    }),
    /** A copy on another board (its columns matched by key/title and type). */
    copyToBoard: useMutation({
      mutationFn: (v: { viewId: string; boardId: string }) =>
        client.post<View>(`/views/${v.viewId}/duplicate`, { board_id: v.boardId }),
      onSuccess: (_view, v) => qc.invalidateQueries({ queryKey: viewKeys.list(accountId, v.boardId) }),
    }),
    remove: useMutation({
      mutationFn: (v: { id: string; name: string }) => client.delete<Deleted>(`/views/${v.id}`),
      onSuccess: async (res, v) => {
        deleted(v.name, res);
        await refresh();
      },
    }),
    /** Leaving / reloading the page: a request that outlives the page (`keepalive`), no cache update. */
    prefsOnLeave: (v: { viewId: string; prefs: ViewPrefs }) =>
      void keepaliveApi(accountId)
        .put(`/views/${v.viewId}/prefs`, v.prefs)
        .catch(() => undefined),
    prefs: useMutation({
      mutationFn: (v: { viewId: string; prefs: ViewPrefs }) => client.put<View>(`/views/${v.viewId}/prefs`, v.prefs),
      onSuccess: put,
    }),
    resetPrefs: useMutation({
      mutationFn: (viewId: string) => client.delete<View>(`/views/${viewId}/prefs`),
      onSuccess: put,
    }),
    open: useMutation({ mutationFn: (viewId: string) => client.post(`/views/${viewId}/open`) }),
    /** My tab layout (pins + order): shown at once, then saved. */
    layout: useMutation({
      mutationFn: (layout: ViewLayout) => client.put<ViewList>(`/boards/${boardId}/views/layout`, layout),
      onMutate: (layout) =>
        qc.setQueryData<ViewList>(key, (old) => (old ? { ...old, layout, data: arrangeViews(old.data, layout) } : old)),
      onSuccess: (list) => qc.setQueryData<ViewList>(key, list),
      onError: refresh,
    }),
    /** Optimistic local prefs (column drag, collapse) before the debounced save lands. */
    patchPrefs: (viewId: string, prefs: ViewPrefs) =>
      qc.setQueryData<ViewList>(key, (old) =>
        old
          ? { ...old, data: old.data.map((v) => (v.id === viewId ? { ...v, prefs: { ...v.prefs, ...prefs } } : v)) }
          : old,
      ),
  };
};

export type ViewMutations = ReturnType<typeof useViewMutations>;
