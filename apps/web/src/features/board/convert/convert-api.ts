// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import {
  type ColumnConversion,
  type ConversionPreview,
  type ConversionSettings,
  type ConvertOptions,
  type FailedConversions,
} from '@bines/shared';
import { api } from '../../../lib/api';

export const conversionKeys = {
  all: (accountId: string, boardId: string) => ['account', accountId, 'board', boardId, 'conversions'] as const,
  column: (accountId: string, boardId: string, columnKey: string) =>
    ['account', accountId, 'board', boardId, 'conversions', 'column', columnKey] as const,
  failed: (accountId: string, boardId: string) =>
    ['account', accountId, 'board', boardId, 'conversions', 'failed'] as const,
  one: (accountId: string, boardId: string, id: string) =>
    ['account', accountId, 'board', boardId, 'conversions', 'one', id] as const,
};

type ConvertBody = { to_type: string; options?: ConvertOptions };

export const previewConversion = (accountId: string, boardId: string, columnKey: string, body: ConvertBody) =>
  api(accountId)
    .post<{ preview: ConversionPreview }>(`/boards/${boardId}/columns/${columnKey}/convert`, { ...body, dry_run: true })
    .then((r) => r.preview);

export const runConversion = (
  accountId: string,
  boardId: string,
  columnKey: string,
  body: ConvertBody & { fingerprint: string },
) =>
  api(accountId)
    .post<{ conversion: ColumnConversion }>(`/boards/${boardId}/columns/${columnKey}/convert`, body)
    .then((r) => r.conversion);

export type RestorePreview = {
  counts: ConversionPreview['counts'];
  changed_since: number;
  dependents: ConversionPreview['dependents'];
  fingerprint: string;
  to_type: string;
};

export const previewRestore = (accountId: string, boardId: string, id: string, force: boolean) =>
  api(accountId)
    .post<{ preview: RestorePreview }>(`/boards/${boardId}/conversions/${id}/restore`, { dry_run: true, force })
    .then((r) => r.preview);

export const runRestore = (accountId: string, boardId: string, id: string, fingerprint: string, force: boolean) =>
  api(accountId)
    .post<{ conversion: ColumnConversion }>(`/boards/${boardId}/conversions/${id}/restore`, { fingerprint, force })
    .then((r) => r.conversion);

export const clearFailed = (accountId: string, boardId: string, id: string) =>
  api(accountId).post(`/boards/${boardId}/conversions/${id}/clear-failed`, {});

/** A column's type changes, newest first (the history dialog). */
export const useColumnConversions = (accountId: string, boardId: string, columnKey: string, enabled = true) =>
  useQuery({
    queryKey: conversionKeys.column(accountId, boardId, columnKey),
    queryFn: () =>
      api(accountId).get<{ data: ColumnConversion[] }>(`/boards/${boardId}/conversions?column_id=${columnKey}`),
    enabled,
  });

/** One conversion — polled while it runs (a large board converts in the background). */
export const useConversion = (accountId: string, boardId: string, id: string | null) =>
  useQuery({
    queryKey: conversionKeys.one(accountId, boardId, id ?? ''),
    queryFn: () => api(accountId).get<ColumnConversion>(`/boards/${boardId}/conversions/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
  });

/** The failed cells of the board's marked conversions (cell marks + the "failed in conversion" filter). */
export const useFailedConversions = (accountId: string, boardId: string) =>
  useQuery({
    queryKey: conversionKeys.failed(accountId, boardId),
    queryFn: () => api(accountId).get<FailedConversions>(`/boards/${boardId}/conversions/failed`),
    enabled: !!boardId,
    staleTime: 60_000,
  });

export const useConversionSettings = (accountId: string, enabled: boolean) =>
  useQuery({
    queryKey: ['account', accountId, 'conversion-settings'],
    queryFn: () => api(accountId).get<ConversionSettings>('/conversions/settings'),
    enabled,
  });
