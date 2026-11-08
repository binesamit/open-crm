// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Deleted,
  DocDetail,
  DocMembers,
  DocThread,
  DocThreads,
  DocVersionContent,
  DocVersions,
  FavoriteDocs,
  InviteToDocResult,
} from '@bines/shared';
import { api } from '../../lib/api';
import { boardKeys } from '../board/board-api';

/** Docs (M8 ד1): the doc's metadata, its members, my favourite docs — and the mutations the sidebar and page use. */
export const docKeys = {
  doc: (accountId: string, docId: string) => ['account', accountId, 'doc', docId] as const,
  members: (accountId: string, docId: string) => ['account', accountId, 'doc', docId, 'members'] as const,
  favorites: (accountId: string) => ['account', accountId, 'favorite-docs'] as const,
};

export const docPath = (accountSlug: string, docId: string) => `/a/${accountSlug}/d/${docId}`;

export const useDoc = (accountId: string, docId: string) =>
  useQuery({
    queryKey: docKeys.doc(accountId, docId),
    queryFn: () => api(accountId).get<DocDetail>(`/docs/${docId}`),
  });

export const useDocMembers = (accountId: string, docId: string, enabled = true) =>
  useQuery({
    queryKey: docKeys.members(accountId, docId),
    queryFn: () => api(accountId).get<DocMembers>(`/docs/${docId}/members`),
    enabled,
  });

export type DocPlace = { after_id: string } | { before_id: string };

export const useDocMutations = (accountId: string) => {
  const qc = useQueryClient();
  const client = api(accountId);
  /** The sidebar (every workspace tree), my favourites and the doc itself. */
  const refresh = async (docId?: string) => {
    await qc.invalidateQueries({ queryKey: ['account', accountId, 'tree'] });
    await qc.invalidateQueries({ queryKey: boardKeys.workspaces(accountId) });
    await qc.invalidateQueries({ queryKey: docKeys.favorites(accountId) });
    if (docId) await qc.invalidateQueries({ queryKey: docKeys.doc(accountId, docId) });
  };
  return {
    create: useMutation({
      mutationFn: (v: { workspaceId: string; folder_id: string | null; name?: string }) =>
        client.post<DocDetail>(`/workspaces/${v.workspaceId}/docs`, { folder_id: v.folder_id, name: v.name }),
      onSuccess: () => refresh(),
    }),
    update: useMutation({
      mutationFn: (v: {
        id: string;
        name?: string;
        icon?: string | null;
        kind?: 'main' | 'private' | 'shareable';
        folder_id?: string | null;
        workspace_id?: string;
        position?: DocPlace;
      }) => {
        const { id, ...patch } = v;
        return client.patch<DocDetail>(`/docs/${id}`, patch);
      },
      onSuccess: (doc) => {
        qc.setQueryData(docKeys.doc(accountId, doc.id), doc);
        return refresh(doc.id);
      },
    }),
    remove: useMutation({
      mutationFn: (v: { id: string; name: string }) => client.delete<Deleted>(`/docs/${v.id}`),
      onSuccess: (_res, v) => refresh(v.id),
    }),
    duplicate: useMutation({
      mutationFn: (v: { id: string }) => client.post<DocDetail>(`/docs/${v.id}/duplicate`, {}),
      onSuccess: () => refresh(),
    }),
    setMembers: useMutation({
      mutationFn: (v: { id: string; members: { type: 'user' | 'team'; id: string; level: string }[] }) =>
        client.put<DocMembers>(`/docs/${v.id}/members`, { members: v.members }),
      onSuccess: (res, v) => {
        qc.setQueryData(docKeys.members(accountId, v.id), res);
        return refresh(v.id);
      },
    }),
  };
};

// ---- ד3: comments, versions, invites ----
export const docThreadKeys = (accountId: string, docId: string) =>
  ['account', accountId, 'doc', docId, 'threads'] as const;
export const docVersionKeys = (accountId: string, docId: string) =>
  ['account', accountId, 'doc', docId, 'versions'] as const;

export const useDocThreads = (accountId: string, docId: string) =>
  useQuery({
    queryKey: docThreadKeys(accountId, docId),
    queryFn: () => api(accountId).get<DocThreads>(`/docs/${docId}/comments`),
    // Others' comments also arrive through the doc's presence (a nudge); this is the fallback.
    refetchInterval: 60_000,
  });

export const useDocThreadMutations = (accountId: string, docId: string, onChanged?: () => void) => {
  const qc = useQueryClient();
  const client = api(accountId);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: docThreadKeys(accountId, docId) });
    await qc.invalidateQueries({ queryKey: docKeys.doc(accountId, docId) });
    // The open-comment count next to the doc in the sidebar.
    await qc.invalidateQueries({ queryKey: ['account', accountId, 'tree'] });
    onChanged?.();
  };
  return {
    create: useMutation({
      mutationFn: (v: { block_id: string; quote: string; body: unknown }) =>
        client.post<DocThread>(`/docs/${docId}/comments`, v),
      onSuccess: done,
    }),
    reply: useMutation({
      mutationFn: (v: { threadId: string; body: unknown }) =>
        client.post<DocThread>(`/doc-comment-threads/${v.threadId}/comments`, { body: v.body }),
      onSuccess: done,
    }),
    resolve: useMutation({
      mutationFn: (v: { threadId: string; resolved: boolean }) =>
        client.post<DocThread>(`/doc-comment-threads/${v.threadId}/resolve`, { resolved: v.resolved }),
      onSuccess: done,
    }),
    edit: useMutation({
      mutationFn: (v: { commentId: string; body: unknown }) =>
        client.patch<DocThread>(`/doc-comments/${v.commentId}`, { body: v.body }),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (v: { commentId: string }) => client.delete<DocThreads>(`/doc-comments/${v.commentId}`),
      onSuccess: done,
    }),
  };
};

export const useDocVersions = (accountId: string, docId: string, enabled = true) =>
  useQuery({
    queryKey: docVersionKeys(accountId, docId),
    queryFn: () => api(accountId).get<DocVersions>(`/docs/${docId}/versions`),
    enabled,
  });

export const useDocVersion = (accountId: string, docId: string, versionId: string | null) =>
  useQuery({
    queryKey: [...docVersionKeys(accountId, docId), versionId],
    queryFn: () => api(accountId).get<DocVersionContent>(`/docs/${docId}/versions/${versionId}`),
    enabled: !!versionId,
  });

export const useDocVersionMutations = (accountId: string, docId: string) => {
  const qc = useQueryClient();
  const client = api(accountId);
  const done = () => qc.invalidateQueries({ queryKey: docVersionKeys(accountId, docId) });
  return {
    save: useMutation({
      mutationFn: (label: string) => client.post<DocVersionContent>(`/docs/${docId}/versions`, { label }),
      onSuccess: done,
    }),
    restore: useMutation({
      mutationFn: (versionId: string) =>
        client.post<DocVersionContent>(`/docs/${docId}/versions/${versionId}/restore`, {}),
      onSuccess: done,
    }),
  };
};

export const useInviteToDoc = (accountId: string, docId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { emails: string[]; role: 'member' | 'guest'; level: string; send_email?: boolean }) =>
      api(accountId).post<InviteToDocResult>(`/docs/${docId}/invite`, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: docKeys.members(accountId, docId) }),
  });
};

/** POST /items/:id/cells/:col/doc — the cell's doc (made on first use). */
export const openCellDoc = (accountId: string, itemId: string, columnKey: string) =>
  api(accountId).post<{ doc: DocDetail; created: boolean }>(`/items/${itemId}/cells/${columnKey}/doc`, {});

/** My favourite docs (like favourite boards): the star applies at once; docs I can no longer open drop out. */
export const useFavoriteDocs = (accountId: string) => {
  const qc = useQueryClient();
  const key = docKeys.favorites(accountId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => api(accountId).get<FavoriteDocs>('/me/favorite-docs'),
    staleTime: 60_000,
  });
  const list = query.data?.data ?? [];
  const save = useMutation({
    mutationFn: (next: FavoriteDocs['data']) =>
      api(accountId).put<FavoriteDocs>('/me/favorite-docs', { doc_ids: next.map((d) => d.id) }),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<FavoriteDocs>(key);
      qc.setQueryData<FavoriteDocs>(key, { data: next });
      return { before };
    },
    // Re-read on failure, never restore a snapshot an overlapping save made stale (audit 2026-10-10 web #7).
    onError: () => void qc.invalidateQueries({ queryKey: key }),
    onSuccess: (res) => qc.setQueryData(key, res),
  });
  const isFavorite = (docId: string) => list.some((d) => d.id === docId);
  const toggle = (doc: { id: string; name: string; workspace_id: string }) =>
    save.mutate(
      isFavorite(doc.id)
        ? list.filter((d) => d.id !== doc.id)
        : [...list, { id: doc.id, name: doc.name, workspace_id: doc.workspace_id }],
    );
  const move = (id: string, overId: string) => {
    const from = list.findIndex((d) => d.id === id);
    const to = list.findIndex((d) => d.id === overId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...list];
    next.splice(to, 0, ...next.splice(from, 1));
    save.mutate(next);
  };
  return { list, loaded: query.isSuccess, isFavorite, toggle, move, error: save.error };
};
