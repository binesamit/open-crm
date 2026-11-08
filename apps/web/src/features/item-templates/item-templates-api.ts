// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  t,
  type ApplyItemTemplate,
  type ApplyItemTemplateResult,
  type CreateItemTemplate,
  type ItemTemplateDto,
  type ItemTemplateSummary,
  type SaveItemAsTemplate,
  type UpdateItemTemplate,
} from '@bines/shared';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';

/** Item templates: a board's list, one template, and the writes (save, edit, delete, apply). */
export const itemTemplateKeys = {
  list: (accountId: string, boardId: string) => ['account', accountId, 'board', boardId, 'item-templates'] as const,
  one: (accountId: string, id: string) => ['account', accountId, 'item-template', id] as const,
};

export const useItemTemplates = (accountId: string, boardId: string, enabled = true) =>
  useQuery({
    queryKey: itemTemplateKeys.list(accountId, boardId),
    queryFn: async () =>
      (await api(accountId).get<{ data: ItemTemplateSummary[] }>(`/boards/${boardId}/item-templates`)).data,
    enabled: enabled && !!boardId,
    staleTime: 30_000,
  });

export const useItemTemplate = (accountId: string, id: string | null) =>
  useQuery({
    queryKey: itemTemplateKeys.one(accountId, id ?? ''),
    queryFn: () => api(accountId).get<ItemTemplateDto>(`/item-templates/${id}`),
    enabled: !!id,
  });

export const useItemTemplateMutations = (accountId: string, boardId: string) => {
  const qc = useQueryClient();
  const client = api(accountId);
  const refreshList = () => qc.invalidateQueries({ queryKey: itemTemplateKeys.list(accountId, boardId) });
  const onError = (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' });
  return {
    saveAs: useMutation({
      mutationFn: (v: { itemId: string } & SaveItemAsTemplate) =>
        client.post<ItemTemplateDto>(`/items/${v.itemId}/save-as-template`, { ...v, itemId: undefined }),
      onSuccess: () => void refreshList(),
      onError,
    }),
    create: useMutation({
      mutationFn: (v: CreateItemTemplate) => client.post<ItemTemplateDto>(`/boards/${boardId}/item-templates`, v),
      onSuccess: () => void refreshList(),
      onError,
    }),
    update: useMutation({
      mutationFn: (v: { id: string } & UpdateItemTemplate) =>
        client.patch<ItemTemplateDto>(`/item-templates/${v.id}`, { ...v, id: undefined }),
      onSuccess: (dto) => {
        qc.setQueryData(itemTemplateKeys.one(accountId, dto.id), dto);
        void refreshList();
      },
      onError,
    }),
    remove: useMutation({
      mutationFn: (v: { id: string; name: string }) => client.delete(`/item-templates/${v.id}`),
      onSuccess: (_r, v) => {
        void refreshList();
        showToast({
          message: t('itemTemplates.deleted', { name: v.name }),
          action: {
            label: t('undo.action'),
            run: async () => {
              await client.post(`/item-templates/${v.id}/restore`, {});
              await refreshList();
            },
          },
        });
      },
      onError,
    }),
    apply: useMutation({
      mutationFn: (v: { id: string } & ApplyItemTemplate) =>
        client.post<ApplyItemTemplateResult>(`/item-templates/${v.id}/apply`, { ...v, id: undefined }),
      onSuccess: async (res) => {
        await qc.invalidateQueries({ queryKey: ['account', accountId, 'board'] });
        await qc.invalidateQueries({ queryKey: ['account', accountId, 'item', res.item_id] });
        showToast({
          message: t('itemTemplates.applied', { n: res.created }),
          action: {
            label: t('undo.action'),
            run: async () => {
              await client.post(`/activity/batches/${res.batch_id}/undo`, {});
              await qc.invalidateQueries({ queryKey: ['account', accountId] });
            },
          },
        });
        if (res.skipped.length)
          showToast({ message: t('itemTemplates.skipped', { n: res.skipped.length }), tone: 'error' });
      },
      onError,
    }),
  };
};
