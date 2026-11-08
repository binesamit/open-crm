// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CatalogReview,
  CatalogSource,
  ExtensionInstallation,
  ExtensionManifest,
  ExtensionVersion,
} from '@bines/shared';
import { api } from '../../lib/api';
import { extKeys } from './extensions-api';

/** Extensions ת6–ת7: versions, the extension's own server, and the owner's catalog publishing. */
export const useExtensionVersions = (accountId: string, installationId: string | null) =>
  useQuery({
    queryKey: ['account', accountId, 'extensions', 'versions', installationId ?? ''] as const,
    queryFn: () =>
      api(accountId).get<{ data: ExtensionVersion[] }>(`/extensions/installations/${installationId}/versions`),
    enabled: !!installationId,
  });

export const useExtensionServerMutations = (accountId: string) => {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: extKeys.list(accountId) });
  return {
    versioning: useMutation({
      mutationFn: (v: { id: string; version_locked?: boolean; auto_update?: boolean }) => {
        const { id, ...patch } = v;
        return api(accountId).patch<ExtensionInstallation>(`/extensions/installations/${id}/versioning`, patch);
      },
      onSuccess: done,
    }),
    rollback: useMutation({
      mutationFn: (v: { id: string; version_id: string }) =>
        api(accountId).post<{ status: 'updated' | 'pending'; installation: ExtensionInstallation }>(
          `/extensions/installations/${v.id}/rollback`,
          { version_id: v.version_id },
        ),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['account', accountId, 'extensions'] }),
    }),
    reconnect: useMutation({
      mutationFn: (id: string) =>
        api(accountId).post<ExtensionInstallation>(`/extensions/installations/${id}/server/reconnect`, {}),
      onSuccess: done,
    }),
  };
};

// ---- owner console: the catalog ----

export type CatalogPreview = {
  manifest: ExtensionManifest;
  kind: 'data' | 'code';
  warnings: string[];
  existing: { version: string } | null;
  review_required: boolean;
};

export const previewCatalog = (source: CatalogSource) =>
  api().post<CatalogPreview>('/platform/extensions/catalog/preview', source);

export const useCatalogMutations = () => {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: extKeys.platform });
  return {
    publish: useMutation({
      mutationFn: (v: { source: CatalogSource; review: CatalogReview }) =>
        api().post('/platform/extensions/catalog', v),
      onSuccess: done,
    }),
    unpublish: useMutation({
      mutationFn: (key: string) => api().delete(`/platform/extensions/catalog/${encodeURIComponent(key)}`),
      onSuccess: done,
    }),
  };
};
