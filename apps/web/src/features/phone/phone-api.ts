// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PhoneActionPrefsResponse,
  SendItemSms,
  SendItemSmsResult,
  SetPhoneActionPrefs,
  SmsStatus,
} from '@bines/shared';
import { api } from '../../lib/api';

/** Plan — the requests behind the phone menu, the SMS dialog and the profile preference. */

export const smsStatusKey = (accountId: string) => ['account', accountId, 'sms-status'] as const;
export const phonePrefsKey = ['me', 'phone-actions'] as const;

/** GET /sms/status — may I send SMS here, the templates, budgets and usage. Shared by every phone cell. */
export const useSmsStatus = (accountId: string, enabled = true) =>
  useQuery({
    queryKey: smsStatusKey(accountId),
    queryFn: () => api(accountId).get<SmsStatus>('/sms/status'),
    enabled: enabled && !!accountId,
    staleTime: 5 * 60_000,
    retry: false,
  });

/** GET /me/phone-actions — what a click on a phone number does for me. */
export const usePhonePrefs = (enabled = true) =>
  useQuery({
    queryKey: phonePrefsKey,
    queryFn: () => api().get<PhoneActionPrefsResponse>('/me/phone-actions'),
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
  });

export const useSetPhonePrefs = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SetPhoneActionPrefs) => api().put<PhoneActionPrefsResponse>('/me/phone-actions', patch),
    onSuccess: (data) => qc.setQueryData(phonePrefsKey, data),
  });
};

/** POST /items/{id}/sms — with `dry_run` only the number and the filled text come back. */
export const useSendSms = (accountId: string, itemId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SendItemSms) => api(accountId).post<SendItemSmsResult>(`/items/${itemId}/sms`, body),
    onSuccess: (res) => {
      if (!res.sent) return;
      // The copy is an update on the item; the budgets' usage moved.
      void qc.invalidateQueries({ queryKey: ['account', accountId, 'item', itemId] });
      void qc.invalidateQueries({ queryKey: smsStatusKey(accountId) });
    },
  });
};
