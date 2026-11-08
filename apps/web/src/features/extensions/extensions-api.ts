// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ExtensionBlocks,
  ExtensionBoardView,
  ExtensionFrameFeature,
  ExtensionCatalogEntry,
  ExtensionConsent,
  ExtensionInstallation,
  ExtensionPreview,
  ExtensionSource,
  ExtensionTokenDto,
  PlatformExtension,
  StarterKitOption,
} from '@bines/shared';
import { api } from '../../lib/api';

/** Extensions — "תוספות" (D27): the admin section, the board views any member may open, the owner console. */
export const extKeys = {
  list: (accountId: string) => ['account', accountId, 'extensions'] as const,
  views: (accountId: string, boardId: string) => ['account', accountId, 'extensions', 'views', boardId] as const,
  platform: ['platform', 'extensions'] as const,
  kits: ['platform', 'starter-kits'] as const,
};

export const useExtensions = (accountId: string) =>
  useQuery({
    queryKey: extKeys.list(accountId),
    queryFn: () =>
      api(accountId).get<{ installed: ExtensionInstallation[]; catalog: ExtensionCatalogEntry[] }>('/extensions'),
  });

/** Board views of enabled extensions on this board (members; guests only where allowed). */
export const useExtensionBoardViews = (accountId: string, boardId: string) =>
  useQuery({
    queryKey: extKeys.views(accountId, boardId),
    queryFn: () =>
      api(accountId).get<{ data: ExtensionBoardView[] }>(
        `/extensions/board-views?board_id=${encodeURIComponent(boardId)}`,
      ),
    staleTime: 60_000,
  });

export const previewExtension = (accountId: string, source: ExtensionSource) =>
  api(accountId).post<ExtensionPreview>('/extensions/preview', source);

/** Where a framed feature's token is for (ת3/ת5): a board, a dashboard widget, or nothing (settings page). */
export type TokenPlace =
  { board_id: string; view_id?: string } | { dashboard_id: string; widget_id: string } | Record<string, never>;

export const mintFeatureToken = (accountId: string, installationId: string, feature: string, place: TokenPlace) =>
  api(accountId).post<ExtensionTokenDto>(`/extensions/installations/${installationId}/token`, {
    feature,
    ...place,
  });

/** Framed features this member may open (item tabs, menu / batch actions, widgets, settings pages). */
export const useExtensionFeatures = (accountId: string, boardId?: string, enabled = true, workspaceId?: string) =>
  useQuery({
    queryKey: [...extKeys.list(accountId), 'features', boardId ?? '', workspaceId ?? ''] as const,
    queryFn: () => {
      const q = new URLSearchParams();
      if (boardId) q.set('board_id', boardId);
      if (workspaceId) q.set('workspace_id', workspaceId);
      const qs = q.toString();
      return api(accountId).get<{ data: ExtensionFrameFeature[] }>(`/extensions/features${qs ? `?${qs}` : ''}`);
    },
    staleTime: 60_000,
    enabled,
  });

/** Automation actions / triggers of enabled extensions on a board (the builder). */
export const useExtensionBlocks = (accountId: string, boardId: string) =>
  useQuery({
    queryKey: [...extKeys.list(accountId), 'blocks', boardId] as const,
    queryFn: () =>
      api(accountId).get<ExtensionBlocks>(`/extensions/automation-blocks?board_id=${encodeURIComponent(boardId)}`),
    staleTime: 60_000,
  });

/** Admins: the installation's signing secret (shown on request), and a new one. */
export const revealExtensionSecret = (accountId: string, id: string) =>
  api(accountId).get<{ secret: string; installation_id: string }>(`/extensions/installations/${id}/secret`);
export const rotateExtensionSecret = (accountId: string, id: string) =>
  api(accountId).post<{ secret: string; installation_id: string }>(`/extensions/installations/${id}/secret/rotate`, {});

export const useExtensionMutations = (accountId: string) => {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: extKeys.list(accountId) });
  return {
    install: useMutation({
      mutationFn: (v: { source: ExtensionSource; consent: ExtensionConsent; manifest_digest?: string }) =>
        api(accountId).post<ExtensionInstallation>('/extensions/install', v),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (v: {
        id: string;
        status?: 'enabled' | 'disabled';
        scopes?: string[];
        board_ids?: string[] | null;
        workspace_ids?: string[] | null;
        allow_guests?: boolean;
      }) => {
        const { id, ...patch } = v;
        return api(accountId).patch<ExtensionInstallation>(`/extensions/installations/${id}`, patch);
      },
      onSuccess: done,
    }),
    uninstall: useMutation({
      mutationFn: (id: string) => api(accountId).delete(`/extensions/installations/${id}`),
      onSuccess: done,
    }),
    checkUpdate: useMutation({
      mutationFn: (id: string) =>
        api(accountId).post<{ status: 'current' | 'updated' | 'pending'; installation: ExtensionInstallation }>(
          `/extensions/installations/${id}/check-update`,
          {},
        ),
      onSuccess: done,
    }),
    approveUpdate: useMutation({
      mutationFn: (v: { id: string; consent: ExtensionConsent; version?: string }) =>
        api(accountId).post<ExtensionInstallation>(`/extensions/installations/${v.id}/approve-update`, {
          consent: v.consent,
          ...(v.version ? { version: v.version } : {}),
        }),
      onSuccess: done,
    }),
  };
};

// ---- owner console ----

export const usePlatformExtensions = () =>
  useQuery({
    queryKey: extKeys.platform,
    queryFn: () => api().get<{ data: PlatformExtension[] }>('/platform/extensions'),
  });

export const useStarterKits = () =>
  useQuery({
    queryKey: extKeys.kits,
    queryFn: () => api().get<{ data: StarterKitOption[] }>('/platform/starter-kits'),
    staleTime: 5 * 60_000,
  });

export const usePlatformExtensionMutations = () => {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: extKeys.platform });
  return {
    kill: useMutation({
      mutationFn: (v: { key: string; reason: string }) => api().post('/platform/extensions/kill', v),
      onSuccess: done,
    }),
    unkill: useMutation({
      mutationFn: (key: string) => api().delete(`/platform/extensions/kill/${encodeURIComponent(key)}`),
      onSuccess: done,
    }),
  };
};
