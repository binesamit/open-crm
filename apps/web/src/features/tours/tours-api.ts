// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MyTours, Tour, TourState } from '@bines/shared';
import { api } from '../../lib/api';

/**
 * Guided tours, the member's side: the tours this person may take in the account (published, their
 * language and role) with what they did with each, and the calls that record it. Everything inside an account.
 */
export const tourKeys = {
  mine: (accountId: string) => ['account', accountId, 'tours'] as const,
  console: ['platform', 'help', 'tours'] as const,
  consoleOne: (id: string) => ['platform', 'help', 'tours', id] as const,
};

export const useMyTours = (accountId: string, enabled = true) =>
  useQuery({
    queryKey: tourKeys.mine(accountId),
    queryFn: () => api(accountId).get<MyTours>('/support/tours'),
    enabled,
    staleTime: 5 * 60_000,
  });

/** Keeps the cached list in step at once (the offer card must not come back while the request is on its way). */
export const useTourActions = (accountId: string) => {
  const qc = useQueryClient();
  const patch = (fn: (d: MyTours) => MyTours) =>
    qc.setQueryData<MyTours>(tourKeys.mine(accountId), (d) => (d ? fn(d) : d));
  const refresh = () => qc.invalidateQueries({ queryKey: tourKeys.mine(accountId) });
  return {
    /** Finished / closed (null: offer it again). A failure never bothers the person — the list is refetched. */
    setState: (tourId: string, state: TourState | null) => {
      patch((d) => ({ ...d, tours: d.tours.map((t) => (t.id === tourId ? { ...t, state } : t)) }));
      void api(accountId)
        .put(`/support/tours/${encodeURIComponent(tourId)}/progress`, { state })
        .catch(() => void refresh());
    },
    resetAll: async () => {
      await api(accountId).delete('/support/tours/progress');
      patch((d) => ({ ...d, tours: d.tours.map((t) => ({ ...t, state: null })) }));
    },
    setOffers: async (offers: boolean) => {
      patch((d) => ({ ...d, offers }));
      try {
        await api(accountId).put('/support/tours/prefs', { offers });
      } catch (e) {
        void refresh();
        throw e;
      }
    },
  };
};

/** The owner console: one tour, a draft too (the preview runs it). */
export const fetchConsoleTour = (id: string) =>
  api().get<Tour>(`/platform/support/help/tours/${encodeURIComponent(id)}`);
