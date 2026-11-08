// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountRole,
  BulkUsers,
  BulkUsersResult,
  DefaultTransferUser,
  RecoveryLink,
  Team,
  TransferOwnership,
  TransferResult,
  UpdateUser,
} from '@bines/shared';
import { api, type Invitation, type Member, queryKeys } from '../../../lib/api';

/** Administration → users (account admin A2): the queries and mutations of the users page. */

export const usersKeys = {
  teams: (accountId: string) => ['account', accountId, 'teams'] as const,
  defaultTransfer: (accountId: string) => ['account', accountId, 'default-transfer-user'] as const,
};

export const useAdminMembers = (accountId: string) =>
  useQuery({
    queryKey: queryKeys.members(accountId),
    queryFn: () => api(accountId).get<{ data: Member[] }>('/users'),
  });

export const useAdminInvitations = (accountId: string) =>
  useQuery({
    queryKey: queryKeys.invitations(accountId),
    queryFn: () => api(accountId).get<{ data: Invitation[] }>('/users/invitations'),
  });

export const useAdminTeams = (accountId: string) =>
  useQuery({
    queryKey: usersKeys.teams(accountId),
    queryFn: () => api(accountId).get<{ data: Team[] }>('/teams'),
  });

export const useDefaultTransfer = (accountId: string) =>
  useQuery({
    queryKey: usersKeys.defaultTransfer(accountId),
    queryFn: () => api(accountId).get<DefaultTransferUser>('/accounts/me/default-transfer-user'),
  });

/** Every write here can change the list (status, role, names in people cells) and the invitations. */
export const useUsersMutations = (accountId: string) => {
  const qc = useQueryClient();
  const client = api(accountId);
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.members(accountId) }),
      qc.invalidateQueries({ queryKey: queryKeys.invitations(accountId) }),
    ]);
  };
  return {
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: UpdateUser }) => client.patch<Member>(`/users/${id}`, patch),
      onSuccess: refresh,
    }),
    setRole: useMutation({
      mutationFn: ({ id, role }: { id: string; role: AccountRole }) => client.patch<Member>(`/users/${id}`, { role }),
      onSuccess: refresh,
    }),
    deactivate: useMutation({
      mutationFn: ({ id, transfer }: { id: string; transfer?: TransferOwnership }) =>
        client.post<{ user: Member; transfer: TransferResult | null }>(`/users/${id}/deactivate`, {
          ...(transfer ? { transfer } : {}),
        }),
      onSuccess: refresh,
    }),
    activate: useMutation({
      mutationFn: (id: string) => client.post<Member>(`/users/${id}/activate`),
      onSuccess: refresh,
    }),
    transfer: useMutation({
      mutationFn: ({ id, body }: { id: string; body: TransferOwnership }) =>
        client.post<TransferResult>(`/users/${id}/transfer-ownership`, body),
      onSuccess: refresh,
    }),
    deleteDetails: useMutation({
      mutationFn: ({ id, display }: { id: string; display: 'deleted' | 'first_name' }) =>
        client.delete<Member>(`/users/${id}/details?display=${display}`),
      onSuccess: refresh,
    }),
    bulk: useMutation({
      mutationFn: (body: BulkUsers) => client.post<BulkUsersResult>('/users/bulk', body),
      onSuccess: refresh,
    }),
    // the same invitation emailed again with a fresh link, valid `days` (default: the account's setting).
    resend: useMutation({
      mutationFn: ({ id, days }: { id: string; days?: number }) =>
        client.post<{ invitation: Invitation; emailed: boolean }>(
          `/users/invitations/${id}/resend${days ? `?expires_in_days=${days}` : ''}`,
        ),
      onSuccess: refresh,
    }),
    // fix8: a fresh invitation link to copy (nothing emailed; the earlier link stops working).
    inviteLink: useMutation({
      mutationFn: ({ id, days }: { id: string; days?: number }) =>
        client.post<{ invitation: Invitation; emailed: boolean }>(
          `/users/invitations/${id}/link${days ? `?expires_in_days=${days}` : ''}`,
        ),
      onSuccess: refresh,
    }),
    // fix8: a one-time sign-in / new-password link for a member (1 hour), copied — never emailed.
    recoveryLink: useMutation({
      mutationFn: (id: string) => client.post<RecoveryLink>(`/users/${id}/recovery-link`),
    }),
    // M8 ד12: turn a member's two-factor authentication off (audited).
    resetTwoFactor: useMutation({
      mutationFn: (id: string) => client.post(`/users/${id}/reset-2fa`),
      onSuccess: refresh,
    }),
    revoke: useMutation({
      mutationFn: (id: string) => client.delete(`/users/invitations/${id}`),
      onSuccess: refresh,
    }),
    setDefaultTransfer: useMutation({
      mutationFn: (userId: string | null) =>
        client.patch<DefaultTransferUser>('/accounts/me/default-transfer-user', { user_id: userId }),
      onSuccess: (data) => qc.setQueryData(usersKeys.defaultTransfer(accountId), data),
    }),
  };
};
