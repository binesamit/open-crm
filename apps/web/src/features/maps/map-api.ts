// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GeoConfig, Place, PlaceSuggestion, UpdateGeoSettings } from '@bines/shared';
import { api } from '../../lib/api';

/** Maps (M8 ד10): the account's map style and address lookups, and the admin's map settings. */
export const geoKey = (accountId: string) => ['account', accountId, 'geo'] as const;

export const useGeoConfig = (accountId: string) =>
  useQuery({
    queryKey: geoKey(accountId),
    queryFn: () => api(accountId).get<GeoConfig>('/geo/config'),
    staleTime: 10 * 60_000,
  });

export const useSaveGeoSettings = (accountId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateGeoSettings) => api(accountId).put<GeoConfig>('/geo/settings', body),
    onSuccess: (cfg) => qc.setQueryData(geoKey(accountId), cfg),
  });
};

export const fetchSuggestions = (accountId: string, q: string) =>
  api(accountId)
    .get<{ data: PlaceSuggestion[] }>(`/geo/autocomplete?q=${encodeURIComponent(q)}`)
    .then((r) => r.data);

export const fetchPlace = (accountId: string, placeId: string) =>
  api(accountId).get<Place>(`/geo/places/${encodeURIComponent(placeId)}`);
