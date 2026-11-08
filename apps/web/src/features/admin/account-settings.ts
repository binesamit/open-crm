// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import type { AccountDetail, UpdateAccount } from '@bines/shared';
import { api, type MyAccount, queryKeys } from '../../lib/api';
import { uploadFile } from '../../lib/upload';
import { applyAccountRegion } from '../../lib/region';

/**
 * The account and its settings (GET /accounts/me, 08 §2) — read by every member (the announcement banner, the
 * logo), changed by admins in Administration → כללי / התראות.
 */
export const accountDetailKey = (accountId: string) => ['account', accountId, 'detail'] as const;

export const useAccountDetail = (account: Pick<MyAccount, 'id'>) =>
  useQuery({
    queryKey: accountDetailKey(account.id),
    queryFn: () => api(account.id).get<AccountDetail>('/accounts/me'),
    staleTime: 60_000,
  });

/**
 * Keeps the runtime region (A3) equal to the account's region settings while inside the account — they are read
 * before the account's pages render (router), and an admin may change them later.
 */
export const useAccountRegionSync = (account: Pick<MyAccount, 'id'>) => {
  const data = useAccountDetail(account).data;
  const locale = data?.settings.locale;
  const calendar = data?.calendar;
  useEffect(() => {
    if (locale) applyAccountRegion(locale, calendar);
  }, [locale, calendar]);
};

/** After a change: the detail is the server's answer; the name and logo also live in the account list and the route. */
const useRefresh = (accountId: string) => {
  const qc = useQueryClient();
  const router = useRouter();
  return async (data: AccountDetail, alsoList: boolean) => {
    qc.setQueryData(accountDetailKey(accountId), data);
    if (alsoList) {
      await qc.invalidateQueries({ queryKey: queryKeys.myAccounts });
      await router.invalidate();
    }
  };
};

/** Custom senders' approval state (S-46): GET /accounts/me/sender-requests (admins). */
export const senderStatusKey = (accountId: string) => ['account', accountId, 'sender-requests'] as const;

/** PATCH /accounts/me (admins): only what is sent changes. */
export const useUpdateAccount = (account: Pick<MyAccount, 'id'>) => {
  const refresh = useRefresh(account.id);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateAccount) => api(account.id).patch<AccountDetail>('/accounts/me', patch),
    onSuccess: async (data, patch) => {
      await refresh(data, patch.name !== undefined);
      // A custom sender may have become a request waiting for the platform owner (S-46).
      if (patch.settings?.branding || patch.settings?.sms || patch.name !== undefined)
        await qc.invalidateQueries({ queryKey: senderStatusKey(account.id) });
    },
  });
};

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** The logo: upload (presign → PUT → complete) then PUT /accounts/me/logo; `null` removes it. */
export const useAccountLogo = (account: Pick<MyAccount, 'id'>) => {
  const refresh = useRefresh(account.id);
  return useMutation({
    mutationFn: async (file: File | null) => {
      const client = api(account.id);
      if (!file) return client.delete<AccountDetail>('/accounts/me/logo');
      if (!file.type.startsWith('image/')) throw { code: 'logo_not_image' };
      if (file.size > MAX_LOGO_BYTES) throw { code: 'logo_too_big' };
      const uploaded = await uploadFile(account.id, file);
      return client.put<AccountDetail>('/accounts/me/logo', { file_id: uploaded.id });
    },
    onSuccess: (data) => refresh(data, true),
  });
};

/** Where an <img> loads an account's logo (a redirect to a signed URL); null = no logo, show the letter mark. */
export const accountLogoSrc = (account: Pick<MyAccount, 'id' | 'logo_asset_id'>) =>
  account.logo_asset_id
    ? `/api/v1/accounts/me/logo?account_id=${encodeURIComponent(account.id)}&v=${encodeURIComponent(account.logo_asset_id)}`
    : null;

/** The email logo (ANSWERS 6א.3): upload then PUT /accounts/me/email-logo; `null` = emails use the account logo. */
export const useAccountEmailLogo = (account: Pick<MyAccount, 'id'>) => {
  const refresh = useRefresh(account.id);
  return useMutation({
    mutationFn: async (file: File | null) => {
      const client = api(account.id);
      if (!file) return client.delete<AccountDetail>('/accounts/me/email-logo');
      if (!file.type.startsWith('image/')) throw { code: 'logo_not_image' };
      if (file.size > MAX_LOGO_BYTES) throw { code: 'logo_too_big' };
      const uploaded = await uploadFile(account.id, file);
      return client.put<AccountDetail>('/accounts/me/email-logo', { file_id: uploaded.id });
    },
    onSuccess: (data) => refresh(data, false),
  });
};
