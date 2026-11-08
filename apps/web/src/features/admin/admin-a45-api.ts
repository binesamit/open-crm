// SPDX-License-Identifier: AGPL-3.0-only
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountSession,
  AdminBoard,
  AuditPage,
  SecuritySettings,
  SignOutResult,
  TransferBoard,
  UpdateSecurity,
  Usage,
} from '@bines/shared';
import { api } from '../../lib/api';

/** Administration A4 + A5: security, sessions, the audit log, usage and tidy up (admins only). */
export const a45Keys = {
  security: (accountId: string) => ['account', accountId, 'admin', 'security'] as const,
  sessions: (accountId: string) => ['account', accountId, 'admin', 'sessions'] as const,
  audit: (accountId: string, query: string) => ['account', accountId, 'admin', 'audit', query] as const,
  usage: (accountId: string, days: number) => ['account', accountId, 'admin', 'usage', days] as const,
  boards: (accountId: string) => ['account', accountId, 'admin', 'boards'] as const,
};

export const useSecurity = (accountId: string) =>
  useQuery({
    queryKey: a45Keys.security(accountId),
    queryFn: () => api(accountId).get<SecuritySettings>('/security'),
  });

export const useUpdateSecurity = (accountId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateSecurity) => api(accountId).patch<SecuritySettings>('/security', patch),
    onSuccess: (data) => qc.setQueryData(a45Keys.security(accountId), data),
  });
};

export const useSessions = (accountId: string) =>
  useQuery({
    queryKey: a45Keys.sessions(accountId),
    queryFn: () => api(accountId).get<{ data: AccountSession[] }>('/security/sessions'),
  });

export const useSessionMutations = (accountId: string) => {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: a45Keys.sessions(accountId) });
  return {
    signOut: useMutation({
      mutationFn: (id: string) => api(accountId).delete<SignOutResult>(`/security/sessions/${id}`),
      onSuccess: refresh,
    }),
    signOutAll: useMutation({
      mutationFn: () => api(accountId).post<SignOutResult>('/security/sessions/sign-out-all'),
      onSuccess: refresh,
    }),
  };
};

/** `query` = the URL search string of the filters (`actor_id=…&event=…&from=…&to=…&page=…`). */
export const useAudit = (accountId: string, query: string) =>
  useQuery({
    queryKey: a45Keys.audit(accountId, query),
    queryFn: () => api(accountId).get<AuditPage>(`/audit${query ? `?${query}` : ''}`),
    placeholderData: keepPreviousData,
  });

export const useUsage = (accountId: string, days: number) =>
  useQuery({
    queryKey: a45Keys.usage(accountId, days),
    queryFn: () => api(accountId).get<Usage>(`/usage?days=${days}`),
    placeholderData: keepPreviousData,
  });

export const useAdminBoards = (accountId: string) =>
  useQuery({
    queryKey: a45Keys.boards(accountId),
    queryFn: () => api(accountId).get<{ data: AdminBoard[] }>('/admin/boards'),
  });

export const useTidyMutations = (accountId: string) => {
  const qc = useQueryClient();
  // The sidebar, the archive and the trash show boards too: everything of the account (this list included).
  const refresh = () => qc.invalidateQueries({ queryKey: ['account', accountId] });
  return {
    archive: useMutation({
      mutationFn: (id: string) => api(accountId).post(`/admin/boards/${id}/archive`),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(accountId).delete(`/admin/boards/${id}`),
      onSuccess: refresh,
    }),
    transfer: useMutation({
      mutationFn: ({ id, body }: { id: string; body: TransferBoard }) =>
        api(accountId).post<AdminBoard>(`/admin/boards/${id}/transfer-ownership`, body),
      onSuccess: refresh,
    }),
  };
};
